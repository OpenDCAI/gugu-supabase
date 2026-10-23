import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from 'vitest'

const db = new pg.Client({ connectionString: process.env.GUGU_INTEGRATION_DATABASE_URL })
let owner: string, outsider: string, sender: string, receiver: string, other: string, foreign: string
const query = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows
const root = () => db.query('RESET ROLE')
const as = async (id: string) => { await db.query('SET LOCAL ROLE authenticated'); await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })]) }
const fails = async (sql: string, args: unknown[]) => {
  await db.query('SAVEPOINT expected_failure')
  try { await db.query(sql, args) } catch (error) { await db.query('ROLLBACK TO SAVEPOINT expected_failure'); return String(error) }
  throw new Error('Expected a permission failure')
}
const commit = 'SELECT * FROM chat.session_attachment_commit($1,$2,$3,$4,$5,$6)'
const urls = 'SELECT * FROM chat.session_attachment_urls_as($1,$2)'
beforeAll(async () => { await db.connect() })
afterAll(async () => { await db.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); outsider = randomUUID()
  for (const id of [owner, outsider]) {
    await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`, [id, id+'@session-files.invalid'])
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')", ['dev-'+id,id])
  }
  sender=randomUUID(); receiver=randomUUID(); other=randomUUID(); foreign=randomUUID()
  for (const [id,own] of [[sender,owner],[receiver,owner],[other,owner],[foreign,outsider]]) {
    await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','fixture',$2,$3)", [id,own,'dev-'+own])
  }
})
afterEach(async () => { await root(); await db.query('ROLLBACK') })

async function upload() {
  const key = 'staging/'+owner+'/'+randomUUID()
  await root(); await db.query('SET LOCAL ROLE service_role')
  const [blob] = await query('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5)',[owner,key,'ab'.repeat(32),4,'application/octet-stream'])
  await as(owner)
  return { key, blob: blob.blob_id }
}
it('only sender, explicitly addressed receiver and owner can resolve; commit retries preserve one immutable file', async () => {
  const uploaded=await upload(), id=randomUUID()
  const args=[uploaded.key,id,sender,'sending-session',[receiver],'original.bin']
  const first=await query(commit,args)
  expect(first).toMatchObject([{attachment_id:id,sha256:'ab'.repeat(32),size_bytes:'4'}])
  expect(await query(commit,args)).toEqual(first)
  for (const actor of [sender,receiver,owner]) expect(await query(urls,[[id],actor])).toHaveLength(1)
  expect(await query(urls,[[id],other])).toEqual([])
  expect(await fails('SELECT * FROM chat.session_attachments',[])).toMatch(/permission denied/)
  expect(await fails(commit,[uploaded.key,id,sender,'sending-session',[other],'original.bin'])).toMatch(/already used differently/)
  expect(await fails(commit,[uploaded.key,randomUUID(),sender,'sending-session',[receiver],'copy.bin'])).toMatch(/already sent/)
  await as(outsider)
  expect(await query(urls,[[id],foreign])).toEqual([])
})
it('refuses a foreign recipient and a human sender, without consuming the upload', async () => {
  const uploaded=await upload()
  expect(await fails(commit,[uploaded.key,randomUUID(),sender,'s',[foreign],'x'])).toMatch(/invalid session/)
  expect(await fails(commit,[uploaded.key,randomUUID(),owner,'s',[receiver],'x'])).toMatch(/sending Agent/)
  expect(await query(commit,[uploaded.key,randomUUID(),sender,'s',[receiver],'x'])).toHaveLength(1)
})
it('revocation immediately blocks signing; live references retain blobs, revoked ones permit actual GC deletion',async () => {
  const uploaded=await upload(), id=randomUUID()
  await query(commit,[uploaded.key,id,sender,'s',[receiver],'x'])
  await root(); await db.query("UPDATE chat.file_blob_uploads SET expires_at=now()-interval '1 hour' WHERE staging_key=$1",[uploaded.key])
  expect((await query('SELECT chat.file_blob_in_use($1) AS used',[uploaded.blob]))[0].used).toBe(true)
  await as(owner)
  expect(await fails('SELECT chat.session_attachment_revoke($1,$2)',[id,receiver])).toMatch(/not yours/)
  await query('SELECT chat.session_attachment_revoke($1,$2)',[id,sender])
  expect(await query(urls,[[id],receiver])).toEqual([])
  await root()
  expect((await query('SELECT chat.file_blob_in_use($1) AS used',[uploaded.blob]))[0].used).toBe(false)
  await db.query('DELETE FROM chat.file_blob_uploads WHERE staging_key=$1',[uploaded.key])
  await db.query('DELETE FROM chat.file_blobs WHERE id=$1',[uploaded.blob])
  expect((await query('SELECT blob_id FROM chat.session_attachments WHERE id=$1',[id]))[0].blob_id).toBe(null)
})
