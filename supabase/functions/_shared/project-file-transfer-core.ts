import { type AttachmentsDeps,call,handleGc,objectStorage,Refusal } from './attachments-core.ts'
import { fileRef,handleFileDownload } from './file-transfer-core.ts'
import { ObjectStorageError } from './object-storage.ts'

function text(body:Record<string,unknown>,name:string) {
  if(typeof body[name]!=='string'||!body[name]) throw new Refusal(400,'invalid',name+' is required')
  return body[name] as string
}
function id(body:Record<string,unknown>,name:string) {
  const value=text(body,name)
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Refusal(400,'invalid',name+' must be a uuid')
  return value
}
export async function handleProjectFiles(deps:AttachmentsDeps,user:string,route:string,body:Record<string,unknown>) {
  const actor=typeof body.as==='string'?body.as:user
  if(route==='file-download') return handleFileDownload(deps,user,body)
  if(route==='file-request') return call(deps.userRpc,'file_temporary_request',{p_ref:fileRef(body.ref),p_as:actor,p_id:id(body,'request_id')})
  if(route==='file-pending') return {transfers:await call(deps.userRpc,'file_temporary_pending',{p_device:text(body,'device_id')})}
  if(route==='file-read-complete') {
    await call(deps.userRpc,'file_temporary_read_complete',{p_download:id(body,'download_id'),p_as:actor})
    return {acknowledged:true}
  }
  if(route.startsWith('file-handoff-')) return handleVersionHandoff(deps,user,actor,route,body)
  const transfer=id(body,'transfer_id'),bytes=body.ciphertext_bytes
  if(typeof bytes!=='number'||!Number.isSafeInteger(bytes)||bytes<1) throw new Refusal(400,'invalid','ciphertext_bytes must be a positive integer')
  const store=objectStorage(deps)
  if(route==='file-accept') {
    const retired=await call(deps.serviceRpc,'file_temporary_expire',{p_limit:500,p_request:transfer,p_host:user,p_needed:bytes})
    if(Number(retired)>0) await handleGc(deps)
    const permit=await call(deps.userRpc,'file_temporary_accept',{p_id:transfer,p_size:bytes}) as {staging_key:string;signed_at:string;expires_at:string;max_bytes:number}
    const seconds=(Date.parse(permit.expires_at)-Date.parse(permit.signed_at))/1000
    const bounds=await store.uploadBounds(bytes,seconds)
    if(bounds.maxBytes!==bytes||bounds.expiresSeconds!==seconds) throw new Refusal(503,'not_configured','Temporary uploads require exact provider size and lifetime limits')
    const form=await store.upload(permit.staging_key,new Date(permit.signed_at),{maxBytes:bytes,expiresSeconds:seconds})
    return {...form,transfer_id:transfer,expires_at:permit.expires_at,max_bytes:bytes}
  }
  if(route!=='file-commit') throw new Refusal(404,'invalid','Unknown project file operation')
  const sha=text(body,'ciphertext_sha256'),key=text(body,'key')
  if(!/^[0-9a-f]{64}$/.test(sha)||!/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(key)) throw new Refusal(400,'invalid','Invalid ciphertext SHA or canonical 256-bit key')
  const decision=await call(deps.serviceRpc,'file_temporary_host_for',{p_id:transfer,p_host:user}) as {object_name:string;ciphertext_bytes:number;state:string}
  if(Number(decision.ciphertext_bytes)!==bytes) throw new Refusal(409,'upload_changed','Ciphertext size differs from its reservation')
  if(decision.state!=='ready') {
    if(!store.inspect) throw new Refusal(503,'not_configured','Streamed object inspection is unavailable')
    const actual=await store.inspect(decision.object_name,bytes)
    if(actual.sizeBytes!==bytes||actual.sha256!==sha) throw new Refusal(409,'upload_changed','Ciphertext differs from its commitment')
  }
  await call(deps.serviceRpc,'file_temporary_commit',{p_id:transfer,p_host:user,p_sha:sha,p_size:bytes,p_key:key})
  return {transfer_id:transfer,status:'ready'}
}

function count(body:Record<string,unknown>,name:string,min:number) {
  const value=body[name]
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min) throw new Refusal(400,'invalid',name+' must be an integer of at least '+min)
  return value
}
/**
 * #577/#791: a member on another machine hands a new file or changed copy to its host, which publishes it as that
 * member's version. The requester uploads the encrypted copy (request, commit) and reads the outcome (status); the host reads what
 * it has to write (pending), downloads it with its key (download) and writes it (publish). Same object store, permits and
 * inspection as temporary transfers, in the other direction.
 */
async function handleVersionHandoff(deps:AttachmentsDeps,user:string,actor:string,route:string,body:Record<string,unknown>) {
  if(route==='file-handoff-pending') return {handoffs:await call(deps.userRpc,'file_version_handoff_pending',{p_device:text(body,'device_id')})}
  if(route==='file-handoff-status') return call(deps.userRpc,'file_version_handoff_status',{p_id:id(body,'handoff_id'),p_cancel:body.cancel===true})
  if(route==='file-handoff-publish') {
    const sha=text(body,'sha256')
    if(!/^[0-9a-f]{64}$/.test(sha)) throw new Refusal(400,'invalid','sha256 must be a lowercase SHA-256')
    return call(deps.userRpc,'file_version_handoff_publish',{p_id:id(body,'handoff_id'),p_path:text(body,'relative_path'),p_sha:sha,p_size:count(body,'size_bytes',0)})
  }
  const store=objectStorage(deps)
  if(route==='file-handoff-request') {
    const sha=text(body,'sha256'),ciphertext=count(body,'ciphertext_bytes',1)
    const creating=body.expected_version===undefined
    if(!creating&&body.chat_id!==undefined) throw new Refusal(400,'invalid','Choose a new file chat or an existing version')
    const target=creating?{p_expected:null,p_chat:text(body,'chat_id')}:{p_expected:count(body,'expected_version',1),p_chat:null}
    if(!/^[0-9a-f]{64}$/.test(sha)) throw new Refusal(400,'invalid','sha256 must be a lowercase SHA-256')
    if(body.message!==undefined&&(typeof body.message!=='object'||body.message===null||Array.isArray(body.message))) throw new Refusal(400,'invalid','message must be an object')
    const cfg=await call(deps.serviceRpc,'file_transfer_settings',{}) as Record<string,unknown>
    const seconds=Number(cfg.upload_permit_seconds)
    let bounds:{maxBytes:number;expiresSeconds:number}
    try { bounds=await store.uploadBounds(ciphertext,seconds) }
    catch(error) {
      if(error instanceof ObjectStorageError&&error.status===503) throw new Refusal(503,'not_configured',error.message)
      throw error
    }
    if(!Number.isSafeInteger(bounds.maxBytes)||bounds.maxBytes<ciphertext||bounds.expiresSeconds!==seconds) {
      throw new Refusal(503,'not_configured','The upload provider size ceiling and lifetime must match deployment policy')
    }
    const row=await call(deps.userRpc,'file_version_handoff_request',{
      p_id:id(body,'handoff_id'),p_item:id(body,'item_id'),...target,p_name:text(body,'file_name'),
      p_type:text(body,'content_type'),p_size:count(body,'size_bytes',0),p_sha:sha,p_ciphertext:ciphertext,p_reserve:bounds.maxBytes,
      p_message:body.message??null,p_as:actor,
    }) as {status:string;staging_key:string;signed_at:string;expires_at:string;max_bytes:number}
    if(row.status!=='uploading'||!row.staging_key) return row
    const form=await store.upload(row.staging_key,new Date(row.signed_at),{maxBytes:Number(row.max_bytes),
      expiresSeconds:(Date.parse(row.expires_at)-Date.parse(row.signed_at))/1000})
    return {...row,upload:{url:form.url,fields:form.fields,...(form.method?{method:form.method}:{}),...(form.headers?{headers:form.headers}:{}),
      expires_at:row.expires_at,max_bytes:Number(row.max_bytes)}}
  }
  const handoff=id(body,'handoff_id')
  if(route==='file-handoff-commit') {
    const bytes=count(body,'ciphertext_bytes',1),sha=text(body,'ciphertext_sha256'),key=text(body,'key')
    if(!/^[0-9a-f]{64}$/.test(sha)||!/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(key)) throw new Refusal(400,'invalid','Invalid ciphertext SHA or canonical 256-bit key')
    if(!store.inspect) throw new Refusal(503,'not_configured','Streamed object inspection is unavailable')
    const upload=await call(deps.serviceRpc,'file_version_handoff_upload',{p_id:handoff,p_account:user}) as {object_name:string;ciphertext_bytes:number;state:string}
    if(Number(upload.ciphertext_bytes)!==bytes) throw new Refusal(409,'upload_changed','Ciphertext size differs from its request')
    if(upload.state==='uploading') {
      const actual=await store.inspect(upload.object_name,bytes)
      if(actual.sizeBytes!==bytes||actual.sha256!==sha) throw new Refusal(409,'upload_changed','Ciphertext differs from its commitment')
    }
    return call(deps.serviceRpc,'file_version_handoff_commit',{p_id:handoff,p_account:user,p_sha:sha,p_size:bytes,p_key:key})
  }
  if(route!=='file-handoff-download') throw new Refusal(404,'invalid','Unknown project file operation')
  const row=await call(deps.serviceRpc,'file_version_handoff_fetch',{p_id:handoff,p_host:user}) as {
    object_name:string;download_id:string;signed_at:string;key:string;ciphertext_bytes:number;ciphertext_sha256:string
  }
  try {
    const signed=await store.sign(row.object_name,false,new Date(row.signed_at),{requestId:row.download_id,expiresSeconds:60,direct:true})
    return {handoff_id:handoff,url:signed.url,key:row.key,codec:'secretstream-v1',ciphertext_bytes:row.ciphertext_bytes,ciphertext_sha256:row.ciphertext_sha256}
  } catch(error) {
    if(error instanceof ObjectStorageError&&error.status===503) throw new Refusal(503,'not_configured',error.message)
    throw error
  }
}
