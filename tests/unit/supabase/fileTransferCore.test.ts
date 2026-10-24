import { describe,expect,it } from 'vitest'
import { inspectFileStream } from '../../../supabase/functions/_shared/file-inspection'
import { fileRef,handleFileResolve } from '../../../supabase/functions/_shared/file-transfer-core'
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
