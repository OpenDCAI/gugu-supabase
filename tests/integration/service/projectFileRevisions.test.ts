import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const url=process.env.GUGU_INTEGRATION_DATABASE_URL??''
let db:pg.Client, owner:string, member:string, outsider:string, hiddenReader:string, group:string, device:string, otherDevice:string, item:string
const sha='ab'.repeat(32), type='application/octet-stream'
const POLICY='SELECT chat.file_project_policy_as($1,$2,$3,$4,$5,$6) AS r'
const PUBLISH='SELECT chat.file_device_publish($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r'
async function user(id=owner) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:id,role:'authenticated'})])
}
async function service() { await db.query('RESET ROLE') }
async function fails(sql:string,args:unknown[]=[]) {
  await db.query('SAVEPOINT refused')
  try { await db.query(sql,args) } catch(error) {
    await db.query('ROLLBACK TO SAVEPOINT refused');return error as pg.DatabaseError
  }
  throw Error('Expected refusal: '+sql)
}
const args=(overrides:Record<number,unknown>={})=>Object.assign([item,group,device,'data/file.bin',sha,123,'file.bin',type,null,null],overrides)
async function publish(overrides:Record<number,unknown>={}) {return (await db.query(PUBLISH,args(overrides))).rows[0].r}
async function resolve(ref:unknown={item_id:item},actor=member) {
  await user(actor)
  return (await db.query('SELECT chat.file_resolve_as($1,$2) AS r',[ref,actor])).rows[0].r
}
beforeAll(async()=>{
  if(!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw Error('Project revision contracts require an isolated loopback database')
  db=new pg.Client({connectionString:url});await db.connect()
})
afterAll(async()=>{await db?.end()})
beforeEach(async()=>{
  await db.query('BEGIN')
  ;[owner,member,outsider,hiddenReader,group,device,otherDevice,item]=Array.from({length:8},randomUUID)
  for(const id of [owner,member,outsider,hiddenReader]) await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`,[id,id+'@project-files.invalid'])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','project revision',$2)",[group,owner])
  // Membership predates binding: existing project members retain their normal read scope.
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')",[group,owner,member,hiddenReader])
  for(const [id,account] of [[device,owner],[otherDevice,member]]) await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'fixture','fixture','linux')`,[id,account])
  await db.query(`INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id)
    VALUES($1,$2,'root','fixture','/private/root',now(),$3)`,[device,owner,group])
  await user()
  await db.query(POLICY,[group,device,'root',false,true,'7d'])
})
afterEach(async()=>{await db.query('ROLLBACK')})

describe('project local metadata, exact references and read-only host ownership',()=>{
  it('keeps defaults local and exposes policy only through the existing membership and actor gates',async()=>{
    await user(member)
    expect((await db.query('SELECT chat.file_project_policy_for($1,$2) AS r',[group,member])).rows[0].r)
      .toMatchObject({proactive_upload:false,temporary_transfer:true,retention:'7d',host_device_id:device,host_project_id:'root'})
    expect((await fails(POLICY,[group,device,'root',true,true,'1d'])).hint).toBe('file_transfer_denied')
    expect((await fails('SELECT chat.file_project_policy_for($1,$2)',[group,owner])).message).toMatch(/Not allowed to act/)
    await user(outsider)
    expect((await fails('SELECT chat.file_project_policy_for($1,$2)',[group,outsider])).message).toBeTruthy()
    await user()
    for(const retention of ['read-once','1d','7d','30d']) expect((await db.query(POLICY,[group,device,'root',false,false,retention])).rows[0].r.retention).toBe(retention)
    expect((await fails(POLICY,[group,device,'root',false,true,'forever'])).code).toBe('23514')
    expect((await fails(POLICY,[group,device,'root',null,true,'7d'])).code).toBe('23502')
    expect((await fails(POLICY,[group,otherDevice,'root',false,true,'7d'])).hint).toBe('file_transfer_denied')
    expect((await fails(POLICY,[group,device,'unbound',false,true,'7d'])).hint).toBe('file_transfer_denied')
  })
  it('admits an image upload to a project chat that keeps files local, and still refuses other files',async()=>{
    // prepare reads the global transfer settings before its policy guard; the transaction rolls this back.
    await service()
    await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=chat.file_transfer_limits.settings||EXCLUDED.settings",
      [{inventory_ready:true,file_max_bytes:1000,upload_permit_seconds:120}])
    await user(member)
    const PREPARE='SELECT chat.file_managed_upload_prepare($1,$2,$3,$4) AS r'
    expect(await fails(PREPARE,[group,member,123,null])).toMatchObject({hint:'file_transfer_denied',message:'Project files are not uploaded proactively'})
    expect(await fails(PREPARE,[group,member,123,'application/pdf'])).toMatchObject({hint:'file_transfer_denied',message:'Project files are not uploaded proactively'})
    expect((await db.query(PREPARE,[group,member,123,'image/png'])).rows[0].r).toMatchObject({chat_id:group})
    expect((await db.query(PREPARE,[group,member,123,'IMAGE/JPEG'])).rows[0].r).toMatchObject({chat_id:group})
  })
  it('publishes immutable device/project/path/SHA metadata, without a cloud blob, URL, key or absolute root',async()=>{
    expect(await publish()).toMatchObject({item_id:item,version:1,sha256:sha,size_bytes:123})
    const local=await resolve()
    expect(local).toMatchObject({status:'ready',source:'local',item_id:item,version:1,sha256:sha,size_bytes:123,
      host_device_id:device,host_project_id:'root',host_account_id:owner,relative_path:'data/file.bin'})
    for(const field of ['url','data_key','root_path','download_id','storage_id']) expect(local[field]).toBeUndefined()
    await service()
    expect((await db.query('SELECT blob_id FROM chat.workspace_items WHERE id=$1',[item])).rows[0].blob_id).toBeNull()
    expect((await db.query('SELECT id FROM chat.file_transfer_storage WHERE blob_id IN (SELECT blob_id FROM chat.workspace_items WHERE id=$1)',[item])).rows).toEqual([])
    expect(await resolve({item_id:item},outsider)).toEqual({status:'gone'})
  })
  it('rejects traversal, ambiguous platform paths, invalid SHA and sizes atomically; Unicode and empty files remain valid',async()=>{
    for(const path of ['/etc/passwd','../secret','a/../../secret','a/./b','a//b','a/','C:/secret','C:secret','a\\b','\\\\server\\file','a\nb','']) {
      expect((await fails(PUBLISH,args({3:path}))).code,path).toBe('23514')
      expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[item])).rows).toEqual([])
    }
    for(const invalid of [{4:'XX'.repeat(32)},{4:'ab'},{5:-1},{7:''}]) expect((await fails(PUBLISH,args(invalid))).code).toBe('23514')
    await publish({3:'资料/空文件.txt',5:0,6:'空文件.txt'})
    expect(await resolve()).toMatchObject({relative_path:'资料/空文件.txt',size_bytes:0})
  })
  it('requires the exact bound owner device and optimistic version, retaining old file names and hashes',async()=>{
    await user(member)
    expect((await fails(PUBLISH,args({2:otherDevice}))).hint).toBe('file_transfer_denied')
    await user()
    await publish()
    expect((await fails(PUBLISH,args())).hint).toBe('file_transfer_conflict')
    expect((await fails(PUBLISH,args({8:99}))).hint).toBe('file_transfer_conflict')
    await publish({3:'data/new.bin',4:'cd'.repeat(32),5:456,6:'new.bin',8:1})
    expect(await resolve({item_id:item})).toMatchObject({version:2,file_name:'new.bin',sha256:'cd'.repeat(32),size_bytes:456})
    expect(await resolve({item_id:item,version:1})).toMatchObject({version:1,file_name:'file.bin',sha256:sha,size_bytes:123})
    expect(await resolve({item_id:item,version:3})).toEqual({status:'gone'})
    expect((await db.query('SELECT updated_by FROM chat.workspace_items WHERE id=$1',[item])).rows[0].updated_by).toBe(owner)
    await service()
    expect((await db.query('SELECT n,device_version,blob_id,inline_text FROM chat.workspace_item_versions WHERE item_id=$1',[item])).rows)
      .toEqual([{n:1,device_version:1,blob_id:null,inline_text:null}])
    expect((await fails("INSERT INTO chat.workspace_item_versions(item_id,n,content_type) VALUES($1,99,$2)",[item,type])).code).toBe('23514')
    expect((await fails("INSERT INTO chat.workspace_item_versions(item_id,n,device_version,content_type) VALUES($1,99,98,$2)",[item,type])).code).toBe('23514')
  })
  it('publishes a composer attachment and its exact message pointer in one transaction through the existing RPC',async()=>{
    const message=randomUUID(),request={message_id:message,to_user_ids:[member],caption:'  shared caption  '}
    const result=(await db.query('SELECT chat.file_device_publish($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS r',[...args(),request])).rows[0].r
    expect(result).toMatchObject({item_id:item,version:1,message:{id:message,chat_id:group,sender_user_id:owner,file_item_id:item,file_version:1,is_whisper:false,to_user_ids:[member]}})
    expect(result.message.content).toBe('[附件] file.bin (application/octet-stream)\n[Size] 123\n[Kind] file\n[Caption]\nshared caption')
    expect(await resolve({message_id:message})).toMatchObject({status:'ready',source:'local',sha256:sha,version:1})
  })
  it('rolls back the local file and revision when message authorization, payload or idempotency rejects sending',async()=>{
    const send='SELECT chat.file_device_publish($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)'
    const message=randomUUID();await db.query(`SELECT * FROM chat.send_message_idempotent($1,$2,$3,'{}','existing','text',NULL,NULL,false,false)`,[message,group,owner])
    expect((await fails(send,[...args(),{message_id:randomUUID(),to_user_ids:[outsider]}])).code).toBe('42501')
    await service()
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[item])).rows).toEqual([])
    expect((await db.query('SELECT item_id FROM chat.file_device_revisions WHERE item_id=$1',[item])).rows).toEqual([])
    await user()
    for(const request of [{message_id:message},{message_id:randomUUID(),is_whisper:true},[],{message_id:randomUUID(),to_user_ids:'invalid'}]) {
      expect((await fails(send,[...args(),request])).message).toBeTruthy()
      await service()
      expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[item])).rows).toEqual([])
      expect((await db.query('SELECT item_id FROM chat.file_device_revisions WHERE item_id=$1',[item])).rows).toEqual([])
      await user()
    }
  })
  it('preserves the existing sender thread fields without introducing a second thread ACL',async()=>{
    const thread=randomUUID(),plainId=randomUUID(),attachmentId=randomUUID()
    const plain=(await db.query(`SELECT * FROM chat.send_message_idempotent($1,$2,$3,'{}','thread control','text',NULL,$4,false,false)`,[plainId,group,owner,thread])).rows[0]
    expect(plain.thread_root_id).toBe(thread)
    const result=(await db.query('SELECT chat.file_device_publish($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS r',[...args(),{message_id:attachmentId,thread_root_id:thread}])).rows[0].r
    expect(result.message).toMatchObject({id:attachmentId,thread_root_id:plain.thread_root_id,file_item_id:item,file_version:1})
  })
  it('preserves the real message pin and refuses retracted or hidden messages even when an item is readable',async()=>{
    await publish()
    // Use the production envelope to exercise the same send trigger as a client.
    await service()
    const envelope=(await db.query('SELECT chat.workspace_version_envelope($1,1) AS e',[item])).rows[0].e
    const id=randomUUID()
    await user()
    await db.query(`SELECT * FROM chat.send_message_idempotent($1,$2,$3,'{}',$4,'attachment',NULL,NULL,false,false,NULL,$5,1)`,[id,group,owner,envelope,item])
    await publish({3:'data/new.bin',4:'cd'.repeat(32),5:456,6:'new.bin',8:1})
    expect(await resolve({message_id:id})).toMatchObject({version:1,sha256:sha,file_name:'file.bin'})
    await service();await db.query('UPDATE chat.messages SET retracted_at=now() WHERE id=$1',[id])
    expect(await resolve({message_id:id})).toEqual({status:'gone'})
    await user()
    const hidden=randomUUID()
    await db.query('INSERT INTO chat.messages(id,chat_id,sender_user_id,content,is_whisper,to_user_ids) VALUES($1,$2,$3,$4,true,$5)',[hidden,group,owner,'private', [hiddenReader]])
    expect(await resolve({message_id:hidden})).toEqual({status:'gone'})
    expect(await resolve({item_id:item})).toMatchObject({status:'ready'})
  })
  it('rejects alternate or malformed reference shapes without manufacturing broader authority',async()=>{
    await publish();await user(member)
    for(const ref of [null,[],{}, {item_id:item,message_id:randomUUID()},{item_id:item,version:0},{item_id:item,version:1.5},
      {item_id:item,version:'1'},{item_id:item,version:1000000000},{item_id:item,path:'../secret'},{attachment_id:randomUUID(),item_id:item}]) {
      expect((await fails('SELECT chat.file_resolve_as($1,$2)',[ref,member])).hint).toBe('file_transfer_invalid')
    }
    expect(await resolve({item_id:'bad-id'})).toEqual({status:'gone'})
    expect(await resolve()).toMatchObject({status:'ready'})
  })
  it('blocks existing mutation APIs for remote readers and stops owner metadata edits that omit a published revision',async()=>{
    await publish();await user(member)
    expect((await fails('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3)',[item,member,'renamed.bin'])).hint).toBe('file_transfer_read_only')
    await user()
    expect((await fails('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3)',[item,owner,'renamed.bin'])).hint).toBe('file_transfer_read_only')
    await publish({3:'data/renamed.bin',6:'renamed.bin',8:1})
    expect(await resolve()).toMatchObject({version:2,file_name:'renamed.bin'})
  })
  it('invalidates an unbound project even if its policy row survives; removal cascades policy but preserves a tombstone',async()=>{
    await publish();await service()
    await db.query('UPDATE identity.device_projects SET chat_id=NULL WHERE device_id=$1',[device])
    expect(await resolve()).toEqual({status:'gone'})
    await service();await db.query('UPDATE identity.device_projects SET chat_id=$2 WHERE device_id=$1',[device,group])
    expect(await resolve()).toMatchObject({status:'ready'})
    await service();await db.query('DELETE FROM identity.device_projects WHERE device_id=$1',[device])
    expect(await resolve()).toEqual({status:'gone'})
    await service()
    expect((await db.query('SELECT item_id FROM chat.file_device_revisions WHERE item_id=$1',[item])).rows).toHaveLength(1)
    expect((await db.query('SELECT chat_id FROM chat.file_project_policies WHERE chat_id=$1',[group])).rows).toEqual([])
  })
  it('does not convert an existing document or cross-group item into a local file',async()=>{
    await service()
    await db.query("INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,created_by) VALUES($1,$2,'document','doc.md','text/markdown',$3)",[item,group,owner])
    await user()
    expect((await fails(PUBLISH,args({8:1}))).hint).toBe('file_transfer_conflict')
    expect((await db.query('SELECT kind FROM chat.workspace_items WHERE id=$1',[item])).rows[0].kind).toBe('document')
  })
  it('continues to resolve existing managed files through their original ACL and distinguishes expired references',async()=>{
    await service()
    const object=group+'/'+owner+'/'+randomUUID()+'.bin'
    await db.query("INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('workspace',$1,$2)",[object,{size:123,mimetype:type}])
    await db.query(`INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,size_bytes,created_by,blob_id)
      VALUES($1,$2,'file','managed.bin',$3,123,$4,chat.file_blob_for_pointer($5,123,$3,$4))`,[item,group,type,owner,object])
    expect(await resolve()).toMatchObject({status:'ready',source:'managed-object',object_name:object})
    expect(await resolve({item_id:item},outsider)).toEqual({status:'gone'})
    await service();await db.query('UPDATE chat.file_transfer_storage_refs SET expired_at=now() WHERE chat_id=$1',[group])
    expect(await resolve()).toMatchObject({status:'expired',source:'managed-object'})
  })
  it('has no direct API table access or public helper grants; intended metadata APIs remain authenticated',async()=>{
    await service()
    for(const role of ['anon','authenticated']) for(const table of ['file_project_policies','file_device_revisions']) {
      for(const permission of ['SELECT','INSERT','UPDATE','DELETE']) expect((await db.query('SELECT has_table_privilege($1,$2,$3) AS ok',[role,'chat.'+table,permission])).rows[0].ok).toBe(false)
    }
    for(const signature of ['file_project_policy_as(text,text,text,boolean,boolean,text)','file_project_policy_for(text,text)',
      'file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb)','file_resolve_as(jsonb,text)']) {
      expect((await db.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS ok",['chat.'+signature])).rows[0].ok).toBe(true)
      expect((await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') AS ok",['chat.'+signature])).rows[0].ok).toBe(false)
    }
    expect((await db.query("SELECT has_function_privilege('authenticated','chat.file_device_read_only()','EXECUTE') AS ok")).rows[0].ok).toBe(false)
    expect((await db.query("SELECT prosecdef FROM pg_proc WHERE oid='chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb)'::regprocedure")).rows[0].prosecdef).toBe(false)
    const inner='file_private.publish_revision(uuid,text,text,text,text,bigint,text,text,integer,uuid)'
    expect((await db.query("SELECT prosecdef FROM pg_proc WHERE oid=$1::regprocedure",[inner])).rows[0].prosecdef).toBe(true)
    expect((await db.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS ok",[inner])).rows[0].ok).toBe(true)
    expect((await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') AS ok",[inner])).rows[0].ok).toBe(false)
    const schemas=(await db.query("SELECT rolconfig FROM pg_roles WHERE rolname='authenticator'")).rows[0].rolconfig
    expect(schemas.find((value:string)=>value.startsWith('pgrst.db_schemas='))).not.toMatch(/file_private/)

  })
})

describe('temporary generations reuse managed budgets and private key issuance',()=>{
  const cipherSha='cd'.repeat(32),key=Buffer.alloc(32,7).toString('base64')
  const DOWNLOAD='SELECT chat.file_transfer_download_as($1,$2,$3) AS r'
  const COMMIT='SELECT chat.file_temporary_commit($1,$2,$3,$4,$5)'
  const cfg={inventory_ready:true,storage_global_bytes:10000,storage_account_bytes:10000,storage_group_bytes:10000,
    download_global_bytes:10000,download_account_bytes:10000,download_group_bytes:10000,
    upload_permit_seconds:120,sign_window_seconds:60,sign_account_count:100,sign_group_count:100,file_max_bytes:1000,temporary_group_bytes:10000}
  beforeEach(async()=>{
    await publish();await service()
    const baseline=Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
    await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings",[{...cfg,storage_global_bytes:baseline+cfg.storage_global_bytes}])
  })
  async function request(id=randomUUID(),ref:unknown={item_id:item}) {
    await user(member)
    return (await db.query('SELECT chat.file_temporary_request($1,$2,$3) AS r',[ref,member,id])).rows[0].r
  }
  async function accept(id:string,size=128) {
    await user()
    return (await db.query('SELECT chat.file_temporary_accept($1,$2) AS r',[id,size])).rows[0].r
  }
  async function ready() {
    const t=await request();await accept(t.transfer_id);await service()
    await db.query(COMMIT,[t.transfer_id,owner,cipherSha,128,key])
    return t.transfer_id as string
  }
  async function download(id=randomUUID(),ref:unknown={item_id:item}) {
    await user(member)
    return (await db.query(DOWNLOAD,[ref,member,id])).rows[0].r
  }
  async function getKey(id:string,account=member) {
    await service()
    return (await db.query('SELECT chat.file_temporary_key_for($1,$2) AS key',[id,account])).rows[0].key
  }
  async function expireTemporary(id:string|null=null,needed=0) {
    await service()
    return (await db.query('SELECT chat.file_temporary_expire(500,$1,$2,$3) AS n',[id,id?owner:null,needed])).rows[0].n
  }
  async function generation(id:string) {
    await service()
    return (await db.query('SELECT * FROM chat.file_temporary_transfers WHERE id=$1',[id])).rows[0]
  }
  async function claim(blob:string) {
    await service()
    return (await db.query('SELECT * FROM chat.file_blob_gc_claim(50,600)')).rows.find(row=>row.blob_id===blob)
  }
  it('requires a real readable reference and enforces disabled project upload policy before issuing normal permits',async()=>{
    await user(outsider)
    expect((await db.query('SELECT chat.file_temporary_request($1,$2,$3) AS r',[{item_id:item},outsider,randomUUID()])).rows[0].r).toEqual({status:'gone'})
    await user()
    expect((await fails('SELECT chat.file_managed_upload_as($1,$2,$3,128)',[randomUUID(),group,owner])).hint).toBe('file_transfer_denied')
    await db.query(POLICY,[group,device,'root',true,true,'7d'])
    expect((await db.query('SELECT chat.file_managed_upload_as($1,$2,$3,128) AS r',[randomUUID(),group,owner])).rows[0].r.max_bytes).toBe(128)
    expect((await request()).transfer_status).toBe('requested')
  })
  it('wakes the existing host device channel with only the request id, not a renderer-only user bus',async()=>{
    const id=randomUUID(),transfer=await request(id)
    await db.query('RESET ROLE')
    const events=(await db.query("SELECT id,topic,event,payload,private FROM realtime.messages WHERE event='files.transfer' AND payload->>'request_id'=$1",[transfer.transfer_id])).rows
    // Realtime adds its own transport UUID; the application sends only the request id.
    expect(events).toHaveLength(1)
    expect(events[0].payload.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(events).toEqual([{id:events[0].payload.id,topic:`gugu:${device}:rpc`,event:'files.transfer',payload:{id:events[0].payload.id,request_id:transfer.transfer_id},private:true}])
    await request(id)
    await db.query('RESET ROLE')
    expect((await db.query("SELECT topic FROM realtime.messages WHERE event='files.transfer' AND payload->>'request_id'=$1",[transfer.transfer_id])).rows).toHaveLength(1)
  })
  it('deduplicates retained generations but preserves request identity, device ownership and pending metadata secrecy',async()=>{
    const id=randomUUID(),first=await request(id),again=await request()
    expect(again.transfer_id).toBe(first.transfer_id)
    await user()
    expect((await fails('SELECT chat.file_temporary_request($1,$2,$3)',[{item_id:item},owner,id])).hint).toBe('file_transfer_conflict')
    const pending=(await db.query('SELECT * FROM chat.file_temporary_pending($1)',[device])).rows.map(row=>Object.values(row)[0])
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({id,relative_path:'data/file.bin',sha256:sha})
    expect(pending[0].data_key).toBeUndefined()
    await user(member)
    expect((await fails('SELECT chat.file_temporary_accept($1,128)',[id])).hint).toBe('file_transfer_denied')
    expect((await fails('SELECT * FROM chat.file_temporary_pending($1)',[device])).hint).toBe('file_transfer_denied')
  })
  it('reserves the exact ciphertext length once, admits the last storage byte, and cannot enlarge or reuse the permit for a new lifetime',async()=>{
    const {transfer_id:id}=await request();await service()
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||'{\"storage_group_bytes\":128,\"storage_account_bytes\":128}'")
    const first=await accept(id)
    expect(await accept(id)).toEqual(first)
    expect((await fails('SELECT chat.file_temporary_accept($1,129)',[id])).hint).toBe('file_transfer_conflict')
    await service();await db.query(COMMIT,[id,owner,cipherSha,128,key])
    expect(Number((await db.query("SELECT chat.file_transfer_usage('upload','group',$1) AS n",[group])).rows[0].n)).toBe(128)
    expect((await db.query('SELECT bucket_id,size_bytes FROM chat.file_blobs WHERE id=(SELECT blob_id FROM chat.file_temporary_transfers WHERE id=$1)',[id])).rows[0]).toEqual({bucket_id:'temporary',size_bytes:'128'})
  })
  it('lets only the host publish a managed next version through the existing upload path when cloud upload is enabled',async()=>{
    await user();await db.query(POLICY,[group,device,'root',true,true,'7d'])
    const permit=(await db.query('SELECT chat.file_managed_upload_as($1,$2,$3,128) AS r',[randomUUID(),group,owner])).rows[0].r
    await service();await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,128,$4)',[owner,permit.staging_key,cipherSha,type])
    await db.query('SELECT chat.file_managed_upload_registered($1,$2)',[permit.staging_key,owner])
    await user();await db.query(POLICY,[group,device,'root',false,true,'7d'])
    const rejected=await fails('SELECT * FROM chat.file_replace_as($1,$2,$3,1)',[permit.staging_key,item,owner]);expect(rejected.hint,rejected.message).toBe('file_transfer_read_only')
    await db.query(POLICY,[group,device,'root',true,true,'7d'])
    await db.query('SELECT * FROM chat.file_replace_as($1,$2,$3,1)',[permit.staging_key,item,owner])
    expect(await resolve()).toMatchObject({status:'ready',source:'managed-object',version:2,sha256:cipherSha})
    expect(await resolve({item_id:item,version:1})).toMatchObject({source:'local',sha256:sha})
    await user(member)
    expect((await fails('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3)',[item,member,'changed.bin'])).hint).toBe('file_transfer_read_only')
  })
  it('stops acceptance at the existing storage budget and retains an abandoned unverified upload allowance',async()=>{
    const {transfer_id:id}=await request();await service()
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||'{\"storage_group_bytes\":127}'")
    await user()
    expect((await fails('SELECT chat.file_temporary_accept($1,128)',[id])).hint).toBe('file_transfer_group_storage_full')
    await service();expect((await db.query('SELECT id FROM chat.file_transfer_reservations WHERE id=$1',[id])).rows).toEqual([])
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||'{\"storage_group_bytes\":128}'")
    await accept(id);await service()
    await db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '1 day' WHERE id=$1",[id])
    expect(Number((await db.query("SELECT chat.file_transfer_usage('upload','group',$1) AS n",[group])).rows[0].n)).toBe(128)
  })
  it('uses the actual issued upload deadline after host acceptance, including a delayed acceptance',async()=>{
    const {transfer_id:id}=await request();await service()
    await db.query("UPDATE chat.file_temporary_transfers SET created_at=now()-interval '119 seconds' WHERE id=$1",[id])
    const permit=await accept(id)
    expect(Date.parse(permit.expires_at)-Date.parse(permit.signed_at)).toBe(120000)
    await service();await db.query("UPDATE chat.file_temporary_transfers SET created_at=now()-interval '5 minutes' WHERE id=$1",[id])
    expect(await expireTemporary()).toBe(0)
    await db.query(COMMIT,[id,owner,cipherSha,128,key])
    expect((await generation(id)).state).toBe('ready')
  })
  it('registers only an immutable service commitment; size, SHA and key changes cannot overwrite a ready generation',async()=>{
    const {transfer_id:id}=await request();await accept(id);await service()
    expect((await fails(COMMIT,[id,owner,cipherSha,127,key])).hint).toBe('file_transfer_conflict')
    expect((await fails(COMMIT,[id,owner,cipherSha,128,'invalid'])).hint).toBe('file_transfer_conflict')
    await db.query(COMMIT,[id,owner,cipherSha,128,key]);await db.query(COMMIT,[id,owner,cipherSha,128,key])
    expect((await fails(COMMIT,[id,owner,sha,128,key])).hint).toBe('file_transfer_conflict')
    expect((await fails(COMMIT,[id,owner,cipherSha,128,Buffer.alloc(32,8).toString('base64')])).hint).toBe('file_transfer_conflict')
    await user()
    expect((await fails(COMMIT,[id,owner,cipherSha,128,key])).code).toBe('42501')
  })
  it('uses the same download reservation and service-only key route, restoring impersonation context after success or refusal',async()=>{
    const transfer=await ready(),id=randomUUID(),row=await download(id)
    expect(row).toMatchObject({status:'ready',bucket_id:'temporary',transfer_id:transfer,plain_size_bytes:123,size_bytes:128,ciphertext_sha256:cipherSha})
    expect(row.data_key).toBeUndefined()
    await service()
    const claims=(await db.query("SELECT current_setting('request.jwt.claims') AS claims")).rows[0].claims
    expect(await getKey(id)).toBe(key)
    expect((await db.query("SELECT current_setting('request.jwt.claims') AS claims")).rows[0].claims).toBe(claims)
    expect((await fails('SELECT chat.file_temporary_key_for($1,$2)',[id,owner])).hint).toBe('file_transfer_denied')
    expect((await db.query("SELECT current_setting('request.jwt.claims') AS claims")).rows[0].claims).toBe(claims)
    await user(member)
    expect((await fails('SELECT chat.file_temporary_key_for($1,$2)',[id,member])).code).toBe('42501')
    expect(await download(id)).toEqual(row)
  })
  it('rechecks the exact message ACL when taking a key and never lets a replacement reference reuse a download identity',async()=>{
    await service();const envelope=(await db.query('SELECT chat.workspace_version_envelope($1,1) AS e',[item])).rows[0].e
    await user();const message=randomUUID()
    await db.query(`SELECT * FROM chat.send_message_idempotent($1,$2,$3,'{}',$4,'attachment',NULL,NULL,false,false,NULL,$5,1)`,[message,group,owner,envelope,item])
    const {transfer_id:id}=await request(randomUUID(),{message_id:message});await accept(id);await service();await db.query(COMMIT,[id,owner,cipherSha,128,key])
    const downloadId=randomUUID();await download(downloadId,{message_id:message})
    await user(member)
    expect((await fails(DOWNLOAD,[{item_id:item},member,downloadId])).hint).toBe('file_transfer_conflict')
    await service();await db.query('UPDATE chat.messages SET retracted_at=now() WHERE id=$1',[message])
    expect((await fails('SELECT chat.file_temporary_key_for($1,$2)',[downloadId,member])).hint).toBe('file_transfer_denied')
  })
  it('denies new signing and keys after removal, unbinding, a new version or policy closure, without refunding issued bytes',async()=>{
    const transfer=await ready(),id=randomUUID();await download(id);await service()
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2',[group,member])
    expect((await fails('SELECT chat.file_temporary_key_for($1,$2)',[id,member])).hint).toBe('file_transfer_denied')
    expect(await download()).toEqual({status:'gone'})
    await service();expect((await db.query('SELECT state,bytes FROM chat.file_transfer_reservations WHERE id=$1',[id])).rows[0]).toEqual({state:'issued',bytes:'128'})
    await user();await publish({8:1,4:'ef'.repeat(32)})
    expect((await fails('SELECT chat.file_temporary_accept($1,128)',[transfer])).hint).toBe('file_transfer_denied')
  })
  it('makes read-once generations private to one download and treats completion as retention only',async()=>{
    await user();await db.query(POLICY,[group,device,'root',false,true,'read-once'])
    await ready();const id=randomUUID(),row=await download(id)
    expect(row.status).toBe('ready');expect((await download()).status).toBe('pending')
    expect(await getKey(id)).toBe(key)
    await user(member);await db.query('SELECT chat.file_temporary_read_complete($1,$2)',[id,member])
    await service()
    expect((await db.query('SELECT state,bytes FROM chat.file_transfer_reservations WHERE id=$1',[id])).rows[0]).toEqual({state:'issued',bytes:'128'})
    expect((await fails('SELECT chat.file_temporary_key_for($1,$2)',[id,member])).hint).toBe('file_transfer_denied')
  })
  it('renews retained data only on a fresh read, never a retry or metadata display, and caps retention at thirty days',async()=>{
    const transfer=await ready(),id=randomUUID();await service()
    await db.query("UPDATE chat.file_temporary_transfers SET created_at=now()-interval '29 days',serve_until=now()+interval '1 hour' WHERE id=$1",[transfer])
    const before=(await generation(transfer)).serve_until
    expect((await resolve()).status).toBe('ready')
    expect((await generation(transfer)).serve_until).toEqual(before)
    expect((await download(id)).status).toBe('ready')
    const renewed=await generation(transfer)
    expect(renewed.serve_until.getTime()-renewed.created_at.getTime()).toBe(30*86400000)
    await service();await db.query("UPDATE chat.file_temporary_transfers SET serve_until=now()+interval '1 hour' WHERE id=$1",[transfer])
    await download(id)
    expect((await generation(transfer)).serve_until).toEqual(before)
  })
  it.each(['expiry','removal','unbinding','new-version','policy'])('retires keys and queues the original blob collector after %s',async(reason)=>{
    const transfer=await ready(),before=await generation(transfer)
    if(reason==='expiry') await db.query("UPDATE chat.file_temporary_transfers SET serve_until=now()-interval '1 second' WHERE id=$1",[transfer])
    if(reason==='removal') await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2',[group,member])
    if(reason==='unbinding') await db.query('UPDATE identity.device_projects SET chat_id=NULL WHERE device_id=$1',[device])
    if(reason==='new-version') { await user();await publish({8:1,4:'ef'.repeat(32)}) }
    if(reason==='policy') { await user();await db.query(POLICY,[group,device,'root',false,false,'7d']) }
    expect(await expireTemporary()).toBe(1)
    expect(await generation(transfer)).toMatchObject({state:'retired',data_key:null})
    expect((await db.query('SELECT blob_id FROM chat.file_blob_gc WHERE blob_id=$1',[before.blob_id])).rows).toHaveLength(1)
    // A still-live upload capability protects against a late upload even after revocation.
    expect(await claim(before.blob_id)).toBeUndefined()
    await db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '1 second' WHERE id=$1",[transfer])
    await db.query('SELECT chat.file_blob_enqueue($1)',[before.blob_id]);await db.query('UPDATE chat.file_blob_gc SET next_attempt_at=now() WHERE blob_id=$1',[before.blob_id])
    const job=await claim(before.blob_id)
    expect(job).toMatchObject({blob_id:before.blob_id,bucket_id:'temporary'})
    const held=Number((await db.query("SELECT chat.file_transfer_usage('upload','group',$1) AS n",[group])).rows[0].n)
    expect(held).toBe(128)
    await db.query('SELECT chat.file_blob_gc_finish($1,$2)',[before.blob_id,job.claim_token])
    expect(Number((await db.query("SELECT chat.file_transfer_usage('upload','group',$1) AS n",[group])).rows[0].n)).toBe(0)
  })
  it('keeps an uncommitted object discoverable after source deletion and holds its allowance after confirmed cleanup',async()=>{
    const {transfer_id:id}=await request();await accept(id)
    const pending=await generation(id)
    expect(pending.blob_id).toBeTruthy()
    await db.query('DELETE FROM chat.chats WHERE id=$1',[group])
    expect((await db.query('SELECT blob_id FROM chat.file_blob_gc WHERE blob_id=$1',[pending.blob_id])).rows).toHaveLength(1)
    expect(await claim(pending.blob_id)).toBeUndefined()
    await db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '1 second' WHERE id=$1",[id])
    await db.query('SELECT chat.file_blob_enqueue($1)',[pending.blob_id]);await db.query('UPDATE chat.file_blob_gc SET next_attempt_at=now() WHERE blob_id=$1',[pending.blob_id])
    const job=await claim(pending.blob_id)
    expect(job).toMatchObject({blob_id:pending.blob_id})
    await db.query('SELECT chat.file_blob_gc_finish($1,$2)',[pending.blob_id,job.claim_token])
    expect((await db.query('SELECT state,bytes,actual_bytes FROM chat.file_transfer_reservations WHERE id=$1',[id])).rows[0]).toEqual({state:'issued',bytes:'128',actual_bytes:'0'})
  })
  it('LRU retires only temporary objects, preserves permanent files, and releases capacity only after GC confirmation',async()=>{
    const old=await ready(),oldRow=await generation(old),permanentSha='ef'.repeat(32)
    const permanent=(await db.query("INSERT INTO chat.file_blobs(bucket_id,object_name,sha256,size_bytes,content_type,created_by) VALUES('oss',$1,$2,64,$3,$4) RETURNING id",['ef/'+permanentSha,permanentSha,type,owner])).rows[0].id
    await db.query('SELECT chat.file_transfer_track($1,$2,$3)',[permanent,group,owner])
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||'{\"temporary_group_bytes\":128,\"storage_group_bytes\":192}'")
    item=randomUUID();await user();await publish()
    const {transfer_id:next}=await request()
    expect(await expireTemporary(next,128)).toBe(1)
    expect(await generation(old)).toMatchObject({state:'retired',data_key:null})
    expect((await db.query('SELECT state FROM chat.file_blobs WHERE id=$1',[permanent])).rows[0].state).toBe('live')
    expect((await db.query('SELECT blob_id FROM chat.file_blob_gc WHERE blob_id=$1',[permanent])).rows).toEqual([])
    await user();expect((await fails('SELECT chat.file_temporary_accept($1,128)',[next])).hint).toBe('file_transfer_group_storage_full')
    await service();await db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '1 second' WHERE id=$1",[old])
    const job=await claim(oldRow.blob_id)
    expect(job).toMatchObject({blob_id:oldRow.blob_id})
    expect(Number((await db.query('SELECT chat.file_temporary_usage($1) AS n',[group])).rows[0].n)).toBe(128)
    await db.query('SELECT chat.file_blob_gc_finish($1,$2)',[oldRow.blob_id,job.claim_token])
    expect((await accept(next)).max_bytes).toBe(128)
    await service();expect((await db.query('SELECT state FROM chat.file_blobs WHERE id=$1',[permanent])).rows[0].state).toBe('live')
  })
  it('keeps maintenance service-only and validates temporary caps and batch sizes before destructive changes',async()=>{
    const {transfer_id:id}=await request()
    await user()
    expect((await fails('SELECT chat.file_temporary_expire()')).code).toBe('42501')
    await service()
    for(const n of [null,0,501]) expect((await fails('SELECT chat.file_temporary_expire($1)',[n])).message).toBe('Invalid temporary expiry batch size')
    expect((await fails('SELECT chat.file_temporary_expire(500,$1,$2,128)',[id,outsider])).hint).toBe('file_transfer_denied')
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||'{\"temporary_group_bytes\":127}'")
    expect((await fails('SELECT chat.file_temporary_expire(500,$1,$2,128)',[id,owner])).hint).toBe('file_transfer_too_large')
    expect((await generation(id)).state).toBe('requested')
  })
  it('refuses a last-byte download overdraft before binding key context',async()=>{
    await ready();await service();await db.query("UPDATE chat.file_transfer_limits SET settings=settings||'{\"download_account_bytes\":127}'")
    const id=randomUUID();await user(member)
    expect((await fails(DOWNLOAD,[{item_id:item},member,id])).hint).toBe('file_transfer_account_download_full')
    await service();expect((await db.query('SELECT id FROM chat.file_transfer_reservations WHERE id=$1',[id])).rows).toEqual([])
  })
})
