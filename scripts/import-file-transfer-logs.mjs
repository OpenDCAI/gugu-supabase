import { createInterface } from 'node:readline'
import { parseTransferLog,parseInventoryEntry } from './file-transfer-log-parser.mjs'

// Feed an authenticated provider export on stdin. Credentials stay in the process environment.
// Re-importing overlapping exports is safe: provider request IDs are immutable event keys.
const source=process.argv[2]
const endpoint=process.env.GUGU_FILE_TRANSFER_IMPORT_URL
const token=process.env.SUPABASE_SERVICE_ROLE_KEY
const domain=process.env.GUGU_FILE_LOG_DOMAIN
const objectPrefix=process.env.GUGU_FILE_LOG_OBJECT_PREFIX??''
if (!['cdn','oss','inventory'].includes(source)||!endpoint||!token||(source!=='inventory'&&!domain)) throw new Error('Set provider, import endpoint, service credential and log source domain')
let target
try { target=new URL(endpoint) } catch { throw new Error('Invalid ingestion endpoint') }
if(target.username||target.password||target.search||target.hash) throw new Error('Do not put credentials or parameters in the ingestion endpoint')
if (target.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(target.hostname)) throw new Error('Remote ingestion requires HTTPS')
let batch=[],lines=0,imported=0,duplicates=0,skipped=0
async function flush() {
  if (!batch.length) return
  const response=await fetch(target,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({[source==='inventory'?'objects':'events']:batch})})
  if (!response.ok) { await response.body?.cancel(); throw new Error('Provider import failed with HTTP '+response.status) }
  const result=await response.json()
  const accepted=source==='inventory'?result.objects:result.imported
  const repeated=source==='inventory'?0:result.duplicates
  if(!Number.isSafeInteger(accepted)||accepted<0||!Number.isSafeInteger(repeated)||repeated<0||accepted+repeated!==batch.length) throw new Error('Invalid provider import receipt')
  imported+=accepted;duplicates+=repeated;batch=[]
}
try {
  for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
    lines++
    let event
    try { const row=JSON.parse(line);event=source==='inventory'?parseInventoryEntry(row):parseTransferLog(source,row,{domain,objectPrefix}) }
    catch { throw new Error('Invalid or unattributed provider record at line '+lines) }
    if (!event) { skipped++; continue }
    batch.push(event)
    if (batch.length===512) await flush()
  }
  await flush()
  console.log(JSON.stringify({lines,imported,duplicates,skipped}))
} catch (error) {
  // Do not echo input or server response bodies: both can contain signed URLs.
  console.error(error instanceof Error?error.message:'Provider import failed');process.exitCode=1
}
