import { describe,expect,it,vi } from 'vitest'
import type { AttachmentsDeps } from '../../../supabase/functions/_shared/attachments-core'
import { inspectFileStream } from '../../../supabase/functions/_shared/file-inspection'
import { fileRef,handleFileResolve,handleFileDownload } from '../../../supabase/functions/_shared/file-transfer-core'
import { cdnSignedUrl } from '../../../supabase/functions/_shared/oss'

describe('streamed file inspection',()=>{
  it('hashes arbitrarily split bytes and retains only a bounded sniffing prefix',async()=>{
    const bytes=Uint8Array.from({length:2500},(_,i)=>i%251)
    const input=new ReadableStream<Uint8Array>({start(c){
      c.enqueue(bytes.subarray(0,3));c.enqueue(bytes.subarray(3,1100));c.enqueue(bytes.subarray(1100));c.close()
    }})
    const result=await inspectFileStream(input,bytes.length)
    expect(result.sizeBytes).toBe(bytes.length)
    expect(result.bytes).toEqual(bytes.subarray(0,512))
    expect(result.sha256).toBe('a75c5b146f3ad9d2e6e54652e71eb6a1d206ffb1348bed2c2f43b51ddaac0f88')
  })
  it('cancels the source as soon as it exceeds its reservation',async()=>{
    let cancelled=false
    const input=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(11))},cancel(){cancelled=true}})
    await expect(inspectFileStream(input,10)).rejects.toMatchObject({status:413})
    expect(cancelled).toBe(true)
  })
})
describe('download input and signed throttles',()=>{
  it('metadata display calls only the read-only RPC and never invokes a provider or signing RPC',async()=>{
    const calls:string[]=[]
    const deps=new Proxy({userRpc:async(fn:string)=>{calls.push(fn);return {data:{status:'expired'},error:null}}},
      {get(target,key){if(key==='userRpc')return target.userRpc;throw Error('Metadata touched '+String(key))}})
    expect(await handleFileResolve(deps as Parameters<typeof handleFileResolve>[0],'reader',{ref:{message_id:'message'}})).toEqual({status:'expired'})
    expect(calls).toEqual(['file_resolve_as'])
  })
  it('batches metadata through the same ACL RPC, preserving each reference and actor without signing',async()=>{
    const calls:unknown[]=[]
    const deps=new Proxy({userRpc:async(fn:string,args:Record<string,unknown>)=>{
      calls.push([fn,args]);return {data:{status:(args.p_ref as {message_id:string}).message_id==='expired'?'expired':'gone'},error:null}
    }},{get(target,key){if(key==='userRpc')return target.userRpc;throw Error('Metadata touched '+String(key))}})
    const refs=[{message_id:'expired'},{message_id:'hidden'}]
    expect(await handleFileResolve(deps as Parameters<typeof handleFileResolve>[0],'reader',{refs,as:'agent'})).toEqual({files:[
      {ref:refs[0],status:'expired'},{ref:refs[1],status:'gone'},
    ]})
    expect(calls).toEqual(refs.map(p_ref=>['file_resolve_as',{p_ref,p_as:'agent'}]))
  })
  it('validates the entire bounded metadata batch before any ACL call',async()=>{
    let calls=0
    const deps={userRpc:async()=>{calls++;return {data:{status:'gone'},error:null}}} as unknown as Parameters<typeof handleFileResolve>[0]
    for(const body of [{refs:[]},{refs:Array.from({length:201},()=>({message_id:'m'}))},{refs:[{message_id:'good'},{message_id:'bad',path:'/secret'}]},
      {refs:[{message_id:'m'}],ref:{message_id:'m'}}]) {
      await expect(handleFileResolve(deps,'reader',body)).rejects.toMatchObject({status:400})
    }
    expect(calls).toBe(0)
  })
  it('uses the CDN edge expiry equation rather than only shortening response metadata',()=>{
    const now=new Date('2026-10-24T00:00:00Z')
    for (const edgeTtl of [60,1800,7200]) {
      const signed=cdnSignedUrl({domain:'files.example.test',authKey:'fixture',authTtlSeconds:edgeTtl},'ab/object',{
        image:false,now,expiresSeconds:60,rand:'fixture',
      })
      const ts=Number(new URL(signed.url).searchParams.get('auth_key')!.split('-')[0])
      expect(ts+edgeTtl).toBe(now.getTime()/1000+60)
      expect(signed.expiresAt).toBe('2026-10-24T00:01:00.000Z')
    }
  })
  it('rejects ambiguous or unbounded references',()=>{
    expect(()=>fileRef({item_id:'a',message_id:'m'})).toThrow()
    expect(()=>fileRef({message_id:'m',extra:'x'})).toThrow()
    expect(()=>fileRef({item_id:'11111111-1111-4111-8111-111111111111',version:-1})).toThrow()
    expect(fileRef({message_id:'m'})).toEqual({message_id:'m'})
  })

})


describe('one download contract with optional provider throttling',()=>{
  const request='11111111-1111-4111-8111-111111111111',at='2026-10-24T00:00:00Z'
  function fixture(bucket='oss',settings:Record<string,unknown>={}) {
    const userRpc=vi.fn<AttachmentsDeps['userRpc']>(async()=>({data:{status:'ready',bucket_id:bucket,object_name:'ab/object',
      download_id:request,signed_at:at,expires_at:'2026-10-24T00:01:00Z',content_type:'application/octet-stream'},error:null}))
    const sign=vi.fn(async()=>({url:'https://bytes.example/file',thumbUrl:null,expiresAt:'2026-10-24T00:01:00Z'}))
    const storageSignedUrl=vi.fn(async()=> 'https://storage.example/file')
    const deps={userRpc,serviceRpc:vi.fn(async()=>({data:settings,error:null})),objects:{sign},storageSignedUrl} as unknown as Parameters<typeof handleFileDownload>[0]
    return {deps,userRpc,sign,storageSignedUrl}
  }
  it.each(['oss','workspace','temporary'])('signs %s without a rate declaration after the same ACL/reservation RPC',async bucket=>{
    const f=fixture(bucket)
    expect(await handleFileDownload(f.deps,'reader',{ref:{message_id:'m'},request_id:request})).toMatchObject({status:'ready'})
    expect(f.userRpc).toHaveBeenCalledExactlyOnceWith('file_transfer_download_as',{p_ref:{message_id:'m'},p_as:'reader',p_id:request})
    if(bucket==='workspace') {
      expect(f.storageSignedUrl).toHaveBeenCalledExactlyOnceWith('workspace','ab/object',60,undefined)
      expect(f.sign).not.toHaveBeenCalled()
    }else {
      expect(f.sign).toHaveBeenCalledExactlyOnceWith('ab/object',false,new Date(at),{requestId:request,expiresSeconds:60,...(bucket==='temporary'?{direct:true}:{})})
      expect(f.storageSignedUrl).not.toHaveBeenCalled()
    }
  })
  it('passes an optional valid rate through the same signer and rejects invalid declarations before provider signing',async()=>{
    const f=fixture('oss',{download_link_bits_per_second:819200})
    await handleFileDownload(f.deps,'reader',{ref:{message_id:'m'},request_id:request})
    expect(f.sign).toHaveBeenCalledExactlyOnceWith('ab/object',false,new Date(at),{requestId:request,expiresSeconds:60,trafficBits:819200})
    for(const rate of [null,0,819199,838860801,Infinity,'invalid']) {
      const bad=fixture('oss',{download_link_bits_per_second:rate})
      await expect(handleFileDownload(bad.deps,'reader',{ref:{message_id:'m'},request_id:request})).rejects.toMatchObject({status:503,code:'not_configured'})
      expect(bad.sign).not.toHaveBeenCalled();expect(bad.storageSignedUrl).not.toHaveBeenCalled()
    }
  })
  it('does not bypass denied or expired metadata when a rate is absent',async()=>{
    const denied=fixture()
    denied.userRpc.mockResolvedValueOnce({data:null,error:{hint:'file_transfer_denied',message:'denied'}})
    await expect(handleFileDownload(denied.deps,'reader',{ref:{message_id:'m'},request_id:request})).rejects.toMatchObject({status:403})
    expect(denied.sign).not.toHaveBeenCalled();expect(denied.deps.serviceRpc).not.toHaveBeenCalled()
    const expired=fixture();expired.userRpc.mockResolvedValueOnce({data:{status:'expired'},error:null})
    expect(await handleFileDownload(expired.deps,'reader',{ref:{message_id:'m'},request_id:request})).toEqual({status:'expired'})
    expect(expired.sign).not.toHaveBeenCalled();expect(expired.deps.serviceRpc).not.toHaveBeenCalled()
  })
})
