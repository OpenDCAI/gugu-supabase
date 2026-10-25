import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { describe,it,expect } from 'vitest'
const fixtureKey='fixture-service-credential'
async function invoke(input:string,url:string,mode='cdn') {
  const child=spawn(process.execPath,[path.resolve('scripts/import-file-transfer-logs.mjs'),mode],{
    env:{...process.env,GUGU_FILE_TRANSFER_IMPORT_URL:url,SUPABASE_SERVICE_ROLE_KEY:fixtureKey,GUGU_FILE_LOG_DOMAIN:'files.example.test'},stdio:['pipe','pipe','pipe'],
  })
  let stdout='',stderr=''
  child.stdout.on('data',v=>{stdout+=v});child.stderr.on('data',v=>{stderr+=v});child.stdin.end(input)
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
  return {code,stdout,stderr}
}
describe('provider export CLI',()=>{
  it('posts a bounded normalized batch, accepts duplicate receipts and never prints credentials or bearer data',async()=>{
    const bodies:unknown[]=[]
    const server=createServer(async(req,res)=>{
      expect(req.headers.authorization).toBe('Bearer '+fixtureKey)
      let input='';for await(const chunk of req) input+=chunk
      const body=JSON.parse(input);bodies.push(body)
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({imported:1,duplicates:1}))
    })
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    try {
      const port=(server.address() as {port:number}).port
      const row={method:'GET',domain:'files.example.test',uri:'/ab/object',uri_param:'auth_key=1792846800-12345678123442348234123456789abc-0-bearer-secret',uuid:'request-1',body_bytes_sent:'5',unixtime:'1792846800'}
      const result=await invoke(JSON.stringify(row)+'\n'+JSON.stringify(row)+'\n','http://127.0.0.1:'+port+'/usage-import')
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({lines:2,imported:1,duplicates:1,skipped:0})
      expect(JSON.stringify(bodies)).not.toContain('auth_key')
      expect(result.stdout+result.stderr).not.toContain(fixtureKey)
      expect(result.stdout+result.stderr).not.toContain('bearer-secret')
    } finally { await new Promise<void>(resolve=>server.close(()=>resolve())) }
  })
  it('refuses unattributed data without posting or echoing the input',async()=>{
    const result=await invoke(JSON.stringify({method:'GET',domain:'files.example.test',uri:'/private-user-name',uri_param:'secret-user-content'})+'\n','http://127.0.0.1:1/usage-import')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('line 1')
    expect(result.stdout+result.stderr).not.toContain('private-user-name')
    expect(result.stdout+result.stderr).not.toContain('secret-user-content')
    expect(result.stdout+result.stderr).not.toContain(fixtureKey)
  })
})
