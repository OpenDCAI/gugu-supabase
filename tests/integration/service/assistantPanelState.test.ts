import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { awaitFact } from '../../support/awaitFact'

let db: pg.Client
let owner: string, stranger: string, agent: string, ordinary: string, device: string, otherDevice: string, instance: string, chat: string
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
type Commit = { operationId: string; revision: string; status: string }
type Snapshot = { revision: string; application: { resourceKey: string; status: string; errorCode: string | null }[]; items: { resource_key: string; revision: string; data: Record<string, unknown>; deleted_at: string | null; body_item_id: string | null }[] }

async function as<T>(user: string, action: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  await db.query('SET LOCAL ROLE authenticated')
  try { return await action() } finally { await db.query('RESET ROLE').catch(() => undefined) }
}
async function failure(action: () => Promise<unknown>, pattern: RegExp) {
  await db.query('SAVEPOINT expected_failure')
  try { await expect(action()).rejects.toThrow(pattern) } finally { await db.query('ROLLBACK TO SAVEPOINT expected_failure') }
}
async function call<T = Record<string, unknown>>(name: string, args: unknown[]): Promise<T> {
  const sql = `SELECT identity.${name}(${args.map((_,i) => `$${i+1}`).join(',')}) AS result`
  return (await db.query<{ result: T }>(sql,args)).rows[0]!.result
}
async function commit(options: {
  key?: string; domain?: string; operation?: string; revision?: string; data?: unknown;
  id?: string; runtime?: string | null; device?: string | null; body?: string | null; hash?: string | null; assistant?: string;
} = {}): Promise<Commit> {
  return as(owner, () => call<Commit>('assistant_panel_commit', [options.assistant ?? agent,options.id ?? randomUUID(),
    options.domain ?? 'personality',options.key ?? 'current',options.revision ?? '0',options.operation ?? 'save',
    JSON.stringify(options.data ?? { text: 'Be concise' }),options.body ?? null,options.hash ?? null,
    options.device ?? null,options.runtime ?? null]))
}
const snapshot = () => as(owner, () => call<Snapshot>('assistant_panel_snapshot',[agent]))
const pending = () => as(owner, () => call<{ revision: string; changes: { operation_id: string; status: string; payload: unknown }[] }>('assistant_panel_pending',[agent,instance]))
const ack = (id: string, error: string | null = null) => as(owner, () => call('assistant_panel_ack',[agent,instance,id,error]))
const admit = (revision: string) => as(owner, () => call<{ admitted: boolean; domain?: string; resourceKey?: string; errorCode?: string }>('assistant_panel_admit',[agent,instance,revision]))

beforeAll(async () => {
  if (!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw new Error('Panel tests require a disposable loopback database')
  db = new pg.Client({ connectionString: url }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); stranger = randomUUID(); agent = randomUUID(); ordinary = randomUUID()
  device = `panel-${randomUUID()}`; otherDevice = `panel-${randomUUID()}`; instance = randomUUID(); chat = randomUUID()
  for (const id of [owner,stranger]) {
    await db.query(`INSERT INTO auth.users(id,instance_id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
      confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
      VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}','','','','',now(),now())`,[id,`${id}@panel.invalid`])
    await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Panel fixture') ON CONFLICT DO NOTHING",[id])
  }
  for (const [id,ownedBy] of [[device,owner],[otherDevice,stranger]]) {
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')",[id,ownedBy])
  }
  for (const id of [agent,ordinary]) await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Panel assistant',$2,$3)",[id,owner,device])
  await db.query("INSERT INTO chat.chats(id,kind,creator_user_id) VALUES($1,'dm',$2)",[chat,owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')",[chat,owner,agent])
  const operation = randomUUID()
  await db.query("INSERT INTO identity.agent_provision_operations(id,owner_user_id,device_id,kind,payload_hash,blueprint,phase) VALUES($1,$2,$3,'single','fixture','{}','completed')",[operation,owner,device])
  await db.query(`INSERT INTO identity.agent_provisions(id,owner_user_id,operation_id,member_key,device_id,display_name,agent_type,
    inherit_memory,history_import_required,payload_hash,agent_user_id,provisioned_agent_user_id,dm_chat_id,phase)
    VALUES($1,$2,$3,'assistant',$4,'Panel assistant','claude-code',false,false,'fixture',$5::text,$5::text::uuid,$6,'completed')`,[randomUUID(),owner,operation,device,agent,chat])
  await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[instance,device,owner])
})
afterEach(async () => { await db.query('ROLLBACK') })

async function file(room = chat) {
  const id = randomUUID(), blob = randomUUID(), hash = randomUUID().replaceAll('-','').repeat(2)
  await db.query("INSERT INTO chat.file_blobs(id,bucket_id,object_name,sha256,size_bytes,content_type,created_by) VALUES($1,'workspace',$2,$3,10,'text/plain',$4)",[blob,`${room}/${blob}`,hash,owner])
  await db.query("INSERT INTO chat.workspace_items(id,chat_id,kind,filename,blob_id,created_by) VALUES($1,$2,'file',$3,$4,$5)",[id,room,`${id}.txt`,blob,owner])
  return { id,blob,hash }
}

describe('durable assistant panel contract', () => {
  it('reads an unprepared account without creating state, messages or device commands', async () => {
    expect(await snapshot()).toEqual({ version: 1,revision: '0',items: [],application: [] })
    expect((await db.query('SELECT count(*)::int AS n FROM identity.assistant_panel_items WHERE assistant_user_id=$1',[agent])).rows[0]!.n).toBe(0)
    expect((await db.query('SELECT count(*)::int AS n FROM identity.gugu_device_commands WHERE user_id=$1',[owner])).rows[0]!.n).toBe(0)
    expect((await db.query('SELECT count(*)::int AS n FROM chat.messages WHERE chat_id=$1',[chat])).rows[0]!.n).toBe(0)
  })

  it('atomically saves current values and ordered deferred changes without waking a host', async () => {
    const saved = await commit()
    expect(saved.status).toBe('pending')
    expect((await snapshot()).items).toEqual([expect.objectContaining({ resource_key: 'current',revision: saved.revision,data: { text: 'Be concise' } })])
    expect((await pending()).changes).toEqual([expect.objectContaining({ operation_id: saved.operationId,status: 'pending' })])
    expect(await admit(saved.revision)).toMatchObject({ admitted: false,domain: 'personality',resourceKey: 'current' })
    await ack(saved.operationId)
    expect(await admit(saved.revision)).toEqual({ admitted: true,revision: saved.revision })
    expect((await db.query('SELECT count(*)::int AS n FROM identity.gugu_device_commands WHERE user_id=$1',[owner])).rows[0]!.n).toBe(0)
  })

  it('is idempotent but rejects reused operation IDs, stale edits and direct DML', async () => {
    const id = randomUUID(), saved = await commit({ id })
    expect(await commit({ id })).toEqual(saved)
    await failure(() => commit({ id,data: { text: 'different' } }),/different request/)
    await failure(() => commit({ data: { text: 'stale' } }),/read it again/)
    await failure(() => as(owner, () => db.query("UPDATE identity.assistant_panel_items SET data='{}' WHERE assistant_user_id=$1",[agent])),/permission denied/)
    await failure(() => as(owner, () => db.query("DELETE FROM identity.assistant_panel_changes WHERE assistant_user_id=$1",[agent])),/permission denied/)
    expect((await pending()).changes).toHaveLength(1)
  })

  it('preserves a committed value and identifies its application failure until retry succeeds', async () => {
    const first = await commit(), second = await commit({ key: 'other',data: { text: 'Second' } })
    expect(await ack(first.operationId,'FILE_WRITE_FAILED')).toMatchObject({ status: 'failed',domain: 'personality',resourceKey: 'current',errorCode: 'FILE_WRITE_FAILED' })
    expect(await admit(second.revision)).toMatchObject({ admitted: false,errorCode: 'FILE_WRITE_FAILED',resourceKey: 'current' })
    await failure(() => ack(second.operationId),/Earlier/)
    await failure(() => ack(first.operationId,'token or raw error'),/non-sensitive/)
    expect((await snapshot()).items.find(i => i.resource_key === 'current')!.data.text).toBe('Be concise')
    expect((await snapshot()).application[0]).toMatchObject({ resourceKey: 'current',status: 'failed',errorCode: 'FILE_WRITE_FAILED' })
    await ack(first.operationId); await ack(first.operationId); await ack(second.operationId)
    expect(await admit(second.revision)).toMatchObject({ admitted: true })
    await commit({ key: 'later',data: { text: 'after the read' } })
    await failure(() => admit(second.revision),/changed before admission/)
  })

  it('isolates owners, personal assistant identities, anonymous callers and resource devices', async () => {
    await commit()
    expect(await as(stranger, () => db.query('SELECT * FROM identity.assistant_panel_items WHERE assistant_user_id=$1',[agent]))).toMatchObject({ rows: [] })
    expect(await as(stranger, () => db.query('SELECT * FROM identity.assistant_panel_changes WHERE assistant_user_id=$1',[agent]))).toMatchObject({ rows: [] })
    await failure(() => as(stranger, () => call('assistant_panel_snapshot',[agent])),/not available/)
    await failure(() => commit({ assistant: ordinary }),/not available/)
    await failure(() => commit({ device: otherDevice }),/not owned/)
    const grants = (await db.query<{ allowed: boolean }>("SELECT has_function_privilege('anon','identity.assistant_panel_snapshot(text)','EXECUTE') AS allowed")).rows[0]!
    expect(grants.allowed).toBe(false)
    expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege('authenticated','identity.assistant_panel_lock(text)','EXECUTE') AS allowed")).rows[0]!.allowed).toBe(false)
  })

  it('accepts only content-addressed snapshots in the exact owner-assistant DM', async () => {
    const body = await file()
    const saved = await commit({ domain: 'memory',key: 'note',data: { title: 'A note',relativePath: 'note.md' },body: body.id,hash: body.hash })
    expect((await snapshot()).items[0]!.body_item_id).toBe(body.id)
    await failure(() => commit({ domain: 'memory',key: 'mismatch',data: {},body: body.id,hash: 'ff'.repeat(32) }),/matching file hash/)
    const room = randomUUID()
    await db.query("INSERT INTO chat.chats(id,kind,creator_user_id) VALUES($1,'dm',$2)",[room,owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')",[room,owner,stranger])
    const wrong = await file(room)
    await failure(() => commit({ domain: 'memory',key: 'wrong',data: {},body: wrong.id,hash: wrong.hash }),/private folder/)
    await failure(() => commit({ domain: 'files',key: 'shared',data: {},body: body.id,hash: body.hash }),/another resource/)
    await failure(() => db.query('UPDATE chat.workspace_items SET blob_id=$2 WHERE id=$1',[body.id,wrong.blob]),/immutable/)
    await ack(saved.operationId)
  })

  it('revokes all published body revisions and leaves a tombstone that late snapshots cannot resurrect', async () => {
    const old = await file(), current = await file()
    const one = await commit({ domain: 'memory',key: 'remember',data: { title: 'Private',relativePath: 'remember.md' },body: old.id,hash: old.hash })
    await ack(one.operationId)
    const two = await commit({ domain: 'memory',key: 'remember',revision: one.revision,data: { title: 'Private',relativePath: 'remember.md' },body: current.id,hash: current.hash })
    await ack(two.operationId)
    const removed = await commit({ domain: 'memory',key: 'remember',revision: two.revision,operation: 'remove',data: {} })
    const row = (await snapshot()).items[0]!
    expect(row).toMatchObject({ data: {},body_item_id: null,revision: removed.revision })
    expect(row.deleted_at).not.toBeNull()
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=ANY($1::uuid[])',[[old.id,current.id]])).rows).toEqual([])
    expect((await pending()).changes[0]!.payload).toEqual({ before: { relativePath: 'remember.md' },deviceId: device,deleted: true })
    expect((await db.query('SELECT count(*)::int AS n FROM identity.gugu_device_commands WHERE user_id=$1',[owner])).rows[0]!.n).toBe(0)
    await ack(removed.operationId)
    await failure(() => commit({ domain: 'memory',key: 'remember',revision: two.revision,data: {},runtime: instance }),/read it again/)
    await failure(() => commit({ domain: 'memory',key: 'remember',revision: removed.revision,data: {},runtime: instance }),/deleted/)
    expect(await admit(removed.revision)).toMatchObject({ admitted: true })
  })

  it('supersedes an unacknowledged save before deleting its body and recovers admission', async () => {
    const body = await file()
    const saved = await commit({ domain: 'memory',key: 'not-yet-applied',data: { relativePath: 'not-yet-applied.md' },body: body.id,hash: body.hash })
    const removed = await commit({ domain: 'memory',key: 'not-yet-applied',revision: saved.revision,operation: 'remove',data: {} })
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[body.id])).rows).toEqual([])
    expect((await pending()).changes.map(c => c.operation_id)).toEqual([removed.operationId])
    // A late result from the obsolete save must not resurrect a failure.
    expect(await ack(saved.operationId,'BODY_READ_FAILED')).toMatchObject({ status: 'superseded' })
    await ack(removed.operationId)
    expect(await admit(removed.revision)).toMatchObject({ admitted: true })
  })

  it('recovers from a failed schedule application when the user corrects the same resource', async () => {
    const saved = await commit({ domain: 'schedules',key: 'recover',data: { cron: 'invalid',tz: 'Invalid/Zone',prompt: 'Review' } })
    await ack(saved.operationId,'SCHEDULE_INVALID')
    const fixed = await commit({ domain: 'schedules',key: 'recover',revision: saved.revision,data: { cron: '0 8 * * *',tz: 'Asia/Shanghai',prompt: 'Review' } })
    expect((await pending()).changes.map(c => c.operation_id)).toEqual([fixed.operationId])
    expect(await ack(saved.operationId,'SCHEDULE_INVALID')).toMatchObject({ status: 'superseded' })
    await ack(fixed.operationId)
    expect(await admit(fixed.revision)).toMatchObject({ admitted: true })
  })

  it.each(['personality','schedules'])('erases deleted %s content from every historical payload', async domain => {
    const data = domain === 'personality' ? { text: 'Forgotten private agreement' } : { prompt: 'Forgotten private prompt',cron: '0 8 * * *' }
    const saved = await commit({ domain,key: 'forget-content',data })
    await ack(saved.operationId)
    const removed = await commit({ domain,key: 'forget-content',revision: saved.revision,operation: 'remove',data: {} })
    const history = await as(owner,() => db.query<{ operation_id: string; payload: unknown }>(
      'SELECT operation_id,payload FROM identity.assistant_panel_changes WHERE assistant_user_id=$1 AND domain=$2 AND resource_key=$3',[agent,domain,'forget-content']))
    expect(history.rows.find(row => row.operation_id === saved.operationId)!.payload).toEqual({})
    expect(JSON.stringify(history.rows)).not.toContain('Forgotten')
    expect((await pending()).changes[0]!.operation_id).toBe(removed.operationId)
  })

  it('rejects deletion of a published body through the private folder without silently nulling its reference', async () => {
    const body = await file()
    const saved = await commit({ domain: 'memory',key: 'protected-body',data: { relativePath: 'protected.md' },body: body.id,hash: body.hash })
    await failure(() => as(owner,() => db.query('SELECT chat.workspace_delete_as($1,$2)',[body.id,owner])),/through the panel/)
    expect((await snapshot()).items[0]).toMatchObject({ body_item_id: body.id,revision: saved.revision })
    await commit({ domain: 'memory',key: 'protected-body',revision: saved.revision,operation: 'remove',data: {} })
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[body.id])).rows).toEqual([])
  })

  it('preserves account privacy erasure and releases body guards after its panel state is gone', async () => {
    const old = await file(), current = await file()
    const first = await commit({ domain: 'memory',key: 'erase-account',data: { relativePath: 'private.md' },body: old.id,hash: old.hash })
    await commit({ domain: 'memory',key: 'erase-account',revision: first.revision,data: { relativePath: 'private.md' },body: current.id,hash: current.hash })
    await db.query('DELETE FROM auth.users WHERE id=$1',[owner])
    expect((await db.query('SELECT 1 FROM identity.assistant_panel_items WHERE assistant_user_id=$1',[agent])).rows).toEqual([])
    expect((await db.query('SELECT 1 FROM identity.assistant_panel_changes WHERE assistant_user_id=$1',[agent])).rows).toEqual([])
    await db.query('DELETE FROM chat.chats WHERE id=$1',[chat])
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=ANY($1::uuid[])',[[old.id,current.id]])).rows).toEqual([])
  })

  it.each(['../escape.md','a/../../escape','./note','a/./note','/absolute','C:\\escape','a\\..\\escape','~/escape','%2e%2e/escape','a//note','note/','note\nother'])('rejects unsafe runtime paths: %j', async path => {
    await failure(() => commit({ domain: 'memory',key: 'bad-path',data: { relativePath: path } }),/normalized relative paths/)
    expect((await snapshot()).revision).toBe('0')
  })

  it('moves assistant-owned resources and error markers to the current home without accepting the former publisher', async () => {
    const note = await commit({ domain: 'memory',key: 'moved',data: { relativePath: 'moved.md' },device,runtime: instance })
    const marker = await commit({ domain: 'memory',key: '__collection__',operation: 'prepared',device,runtime: instance,data: { state: 'ready',schemaVersion: 1,itemCount: 1 } })
    const nextDevice = `panel-${randomUUID()}`, nextInstance = randomUUID()
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'new','new','linux')",[nextDevice,owner])
    await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[nextInstance,nextDevice,owner])
    await db.query("INSERT INTO identity.agent_profiles(id,owner_id,display_name,agent_type) VALUES($1,$2,'Panel assistant','claude-code')",[agent,owner])
    const move = randomUUID(), provision = randomUUID()
    const member = { provision_id: provision,member_key: 'single',display_name: 'Panel assistant',agent_type: 'claude-code',
      project_path: '',inherit_memory: false,history_import_required: false,existing_agent_user_id: agent }
    await as(owner,async () => {
      await db.query('SELECT identity.start_agent_provision_operation($1,$2,$3::jsonb,NULL,NULL,$4,NULL,$5,$6,NULL)',
        [move,nextDevice,JSON.stringify({ kind: 'single',members: [member] }),'platform:deepseek-v4-pro','full-access','claude'])
      await db.query('SELECT identity.claim_provision_slots($1)',[move])
      await db.query('SELECT identity.prepare_agent_provision($1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,NULL)',
        [provision,move,'single',nextDevice,'Panel assistant','claude-code',''])
    })
    await db.query("UPDATE identity.gugu_device_commands SET status='done',completed_at=now() WHERE id=(SELECT create_command_id FROM identity.agent_provisions WHERE id=$1)",[provision])
    await as(owner,async () => {
      await db.query('SELECT identity.settle_agent_provision_terminal($1)',[provision])
      await db.query('SELECT identity.complete_agent_provision($1)',[provision])
    })
    await failure(() => commit({ domain: 'memory',key: 'moved',revision: note.revision,data: {},runtime: instance }),/required device/)
    await commit({ domain: 'memory',key: 'moved',revision: note.revision,data: { relativePath: 'moved.md' },device: nextDevice,runtime: nextInstance })
    await commit({ domain: 'memory',key: '__collection__',revision: marker.revision,operation: 'error',device: nextDevice,runtime: nextInstance,data: { state: 'error',schemaVersion: 1,errorCode: 'READ_FAILED' } })
    expect((await snapshot()).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource_key: 'moved',device_id: nextDevice }),
      expect.objectContaining({ resource_key: '__collection__',device_id: nextDevice,data: { state: 'error',schemaVersion: 1,errorCode: 'READ_FAILED' } }),
    ]))
  })

  it('refuses unsupported panel edits of non-home device resources while keeping their published metadata readable', async () => {
    const nextDevice = `panel-${randomUUID()}`, nextInstance = randomUUID()
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'other','other','linux')",[nextDevice,owner])
    await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[nextInstance,nextDevice,owner])
    const published = await commit({ domain: 'integrations',key: 'other-account',device: nextDevice,runtime: nextInstance,data: { configured: true } })
    await failure(() => commit({ domain: 'integrations',key: 'other-account',revision: published.revision,operation: 'disable',data: {} }),/non-home device/)
    expect((await snapshot()).items[0]!.data.configured).toBe(true)
    expect((await pending()).changes).toEqual([])
  })

  it('rejects an individually oversized write before changing state', async () => {
    await failure(() => commit({ data: { text: 'x'.repeat(262144) } }),/256 KiB/)
    expect((await snapshot()).revision).toBe('0')
    expect((await pending()).changes).toEqual([])
  })

  it.each(['snapshot','pending'])('rejects aggregate %s overflow while the preceding complete representation remains readable', async representation => {
    const initial = await commit()
    await ack(initial.operationId)
    if (representation === 'snapshot') {
      await db.query(`INSERT INTO identity.assistant_panel_items(assistant_user_id,owner_user_id,domain,resource_key,data)
        SELECT $1,$2,'personality','fill-' || n,jsonb_build_object('text',repeat('x',255000)) FROM generate_series(1,65) n`,[agent,owner])
    } else {
      await db.query(`INSERT INTO identity.assistant_panel_changes(operation_id,assistant_user_id,owner_user_id,domain,resource_key,
        source,operation,expected_item_revision,request_hash,payload,status)
        SELECT gen_random_uuid(),$1,$2,'personality','fill-' || n,'panel','save',0,'fixture',
          jsonb_build_object('data',jsonb_build_object('text',repeat('x',255000))),'pending' FROM generate_series(1,65) n`,[agent,owner])
    }
    await failure(() => commit({ key: 'overflow',data: { text: 'x'.repeat(255000) } }),/complete response budget/)
    expect((await snapshot()).items.some(i => i.resource_key === 'overflow')).toBe(false)
    expect((await pending()).changes.some(c => c.operation_id === initial.operationId)).toBe(false)
  })

  it('prunes terminal receipts after 30 days while retaining revocation and unapplied intent', async () => {
    const body = await file(), replacement = await file()
    const old = await commit({ domain: 'memory',key: 'old-body',data: { relativePath: 'old.md' },body: body.id,hash: body.hash })
    await ack(old.operationId)
    const current = await commit({ domain: 'memory',key: 'old-body',revision: old.revision,data: { relativePath: 'old.md' },body: replacement.id,hash: replacement.hash })
    const tombstone = await commit({ key: 'revoked',operation: 'remove',data: {} })
    await ack(current.operationId); await ack(tombstone.operationId)
    const unapplied = await commit({ key: 'must-remain' })
    await db.query("UPDATE identity.assistant_panel_changes SET created_at=now()-interval '31 days',applied_at=CASE WHEN status='applied' THEN now()-interval '31 days' END WHERE assistant_user_id=$1",[agent])
    await commit({ key: 'prune-trigger' })
    expect((await db.query('SELECT operation_id FROM identity.assistant_panel_changes WHERE operation_id=ANY($1::uuid[])',[[old.operationId,current.operationId,tombstone.operationId]])).rows).toEqual([])
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[body.id])).rows).toEqual([])
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[replacement.id])).rows).toHaveLength(1)
    expect((await pending()).changes.map(c => c.operation_id)).toContain(unapplied.operationId)
    await failure(() => commit({ key: 'revoked',revision: tombstone.revision }),/deleted/)
  })

  it('durably records allowlisted App notices without changing desired resources, sending messages or waking a host', async () => {
    const change = { operationId: randomUUID(),resource: 'projects',operation: 'edited',id: 'project-a',deviceId: device,after: { name: 'New name',path: '/work/project' } }
    const notice = () => as(owner,() => call<Commit>('assistant_panel_notice',[agent,JSON.stringify(change)]))
    const saved = await notice()
    expect(await notice()).toEqual(saved)
    expect((await snapshot()).items).toEqual([])
    expect((await pending()).changes[0]!.payload).toEqual({ notice: change })
    await failure(() => as(stranger,() => call('assistant_panel_notice',[agent,JSON.stringify(change)])),/not available/)
    await failure(() => as(owner,() => call('assistant_panel_notice',[agent,JSON.stringify({ ...change,after: { text: 'Resource body is forbidden' } })])),/unsupported content/)
    await failure(() => as(owner,() => call('assistant_panel_notice',[agent,JSON.stringify({ ...change,operationId: randomUUID(),deviceId: otherDevice })])),/not owned/)
    await failure(() => as(owner,() => call('assistant_panel_notice',[agent,JSON.stringify({ ...change,after: { path: '/work/../outside' } })])),/traversal/)
    await ack(saved.operationId)
    expect(await admit(saved.revision)).toMatchObject({ admitted: true })
    expect((await db.query('SELECT count(*)::int AS n FROM identity.gugu_device_commands WHERE user_id=$1',[owner])).rows[0]!.n).toBe(0)
    expect((await db.query('SELECT count(*)::int AS n FROM chat.messages WHERE chat_id=$1',[chat])).rows[0]!.n).toBe(0)
  })

  it('rolls back both current state and its queue if validation or body removal fails', async () => {
    const initial = await commit()
    await failure(() => commit({ revision: initial.revision,data: { credentials: 'never store this' } }),/unsupported fields/)
    expect((await snapshot()).revision).toBe(initial.revision)
    expect((await pending()).changes).toHaveLength(1)
    const body = await file()
    const note = await commit({ domain: 'memory',key: 'protected',data: { relativePath: 'protected.md' },body: body.id,hash: body.hash })
    // Revoke the referenced file's deletion permission, without global DDL that
    // could interfere with other integration suites using the same table.
    await db.query('UPDATE chat.workspace_items SET created_by=$2 WHERE id=$1',[body.id,stranger])
    await failure(() => commit({ domain: 'memory',key: 'protected',revision: note.revision,operation: 'remove',data: {} }),/删不了/)
    expect((await snapshot()).items.find(i => i.resource_key === 'protected')!.deleted_at).toBeNull()
    expect((await pending()).changes).toHaveLength(2)
  })

  it('keeps failed preparation distinct from an empty prepared collection and validates its complete count', async () => {
    await failure(() => commit({ domain: 'memory',key: '__collection__',operation: 'prepared',data: { state: 'ready',schemaVersion: 1,itemCount: 0 } }),/match its resource/)
    await failure(() => commit({ domain: 'memory',key: '__collection__',operation: 'prepared',runtime: instance,data: { schemaVersion: 1,itemCount: 0 } }),/invalid/)
    await failure(() => commit({ domain: 'memory',key: '__collection__',operation: 'prepared',runtime: instance,data: { state: 'ready',schemaVersion: 1,itemCount: 1 } }),/complete/)
    const failed = await commit({ domain: 'memory',key: '__collection__',operation: 'error',runtime: instance,data: { state: 'error',schemaVersion: 1,errorCode: 'READ_FAILED' } })
    expect((await snapshot()).items[0]!.data.state).toBe('error')
    await commit({ domain: 'memory',key: '__collection__',operation: 'prepared',runtime: instance,revision: failed.revision,data: { state: 'ready',schemaVersion: 1,itemCount: 0 } })
    expect((await snapshot()).items[0]!.data.state).toBe('ready')
  })

  it('tracks preparation per device without marking another device data complete', async () => {
    const nextDevice = `panel-${randomUUID()}`, nextInstance = randomUUID()
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'other','other','linux')",[nextDevice,owner])
    await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[nextInstance,nextDevice,owner])
    await commit({ domain: 'device-notes',key: 'first-device',device,runtime: instance,data: { name: 'First' } })
    await commit({ domain: 'device-notes',key: 'second-device',device: nextDevice,runtime: nextInstance,data: { name: 'Second' } })
    await failure(() => commit({ domain: 'device-notes',key: `__collection__:${nextDevice}`,operation: 'prepared',device,runtime: instance,data: { state: 'ready',schemaVersion: 1,itemCount: 1 } }),/identify its resource device/)
    await commit({ domain: 'device-notes',key: `__collection__:${device}`,operation: 'prepared',device,runtime: instance,data: { state: 'ready',schemaVersion: 1,itemCount: 1 } })
    expect((await snapshot()).items.filter(i => i.resource_key.startsWith('__collection__:'))).toEqual([
      expect.objectContaining({ resource_key: `__collection__:${device}`,data: { state: 'ready',schemaVersion: 1,itemCount: 1 } }),
    ])
    const secondRevision = (await snapshot()).items.find(i => i.resource_key === 'second-device')!.revision
    await failure(() => commit({ domain: 'device-notes',key: 'second-device',device,runtime: instance,data: { name: 'Wrong device' },revision: secondRevision }),/another device/)
  })

  it('blocks expired, competing and former-home publishers and never overwrites pending user intent', async () => {
    const saved = await commit()
    await failure(() => commit({ revision: saved.revision,runtime: instance }),/Apply the committed/)
    await ack(saved.operationId)
    const rival = randomUUID()
    await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[rival,device,owner])
    await failure(() => commit({ key: 'rival',runtime: rival }),/active lease/)
    await db.query("UPDATE identity.runtime_instances SET last_heartbeat_at=now()-interval '5 minutes' WHERE instance_id=$1",[instance])
    await failure(() => pending(),/not a current runtime/)
    await commit({ key: 'rival',runtime: rival })
    const nextDevice = `panel-${randomUUID()}`
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'new','new','linux')",[nextDevice,owner])
    const wrong = randomUUID()
    await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[wrong,nextDevice,owner])
    await failure(() => commit({ key: 'wrong-home',runtime: wrong }),/required device/)
    await db.query("UPDATE identity.agent_provisions SET phase='cancelled' WHERE agent_user_id=$1",[agent])
    await failure(() => commit({ key: 'former-home',runtime: rival }),/not available/)
  })

  it('toggles schedule intent immediately while retaining cron, prompt and time zone', async () => {
    const schedule = await commit({ domain: 'schedules',key: 'daily',data: { title: 'Daily',prompt: 'Review',cron: '0 8 * * *',tz: 'Asia/Shanghai',enabled: true },runtime: instance })
    const stopped = await commit({ domain: 'schedules',key: 'daily',revision: schedule.revision,operation: 'disable',data: {} })
    expect((await snapshot()).items[0]!.data).toMatchObject({ cron: '0 8 * * *',tz: 'Asia/Shanghai',prompt: 'Review',enabled: false })
    expect(await admit(stopped.revision)).toMatchObject({ admitted: false,domain: 'schedules',resourceKey: 'daily' })
    await ack(stopped.operationId)
    expect(await admit(stopped.revision)).toMatchObject({ admitted: true })
  })

  it.each(['edit','publish','admit'])('serializes a committed deletion against a concurrent %s without exposing a half-committed queue', async (action) => {
    const initial = await commit({ domain: 'memory',key: 'race',data: { relativePath: 'race.md' },runtime: instance })
    await db.query('COMMIT')
    const first = new pg.Client({ connectionString: url }), second = new pg.Client({ connectionString: url })
    try {
      await first.connect(); await second.connect()
      for (const client of [first,second]) {
        await client.query('BEGIN')
        await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({ sub: owner,role: 'authenticated' })])
        await client.query('SET LOCAL ROLE authenticated')
      }
      const deletion = (await first.query<{ result: Commit }>(
        "SELECT identity.assistant_panel_commit($1,$2,'memory','race',$3,'remove','{}') AS result",
        [agent,randomUUID(),initial.revision])).rows[0]!.result
      // An independent reader still sees the previous complete state until commit.
      await db.query('BEGIN')
      expect((await snapshot()).items[0]!.deleted_at).toBeNull()
      expect((await db.query('SELECT operation_id FROM identity.assistant_panel_changes WHERE operation_id=$1',[deletion.operationId])).rows).toEqual([])
      await db.query('COMMIT')
      const pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      const result = (action === 'admit'
        ? second.query('SELECT identity.assistant_panel_admit($1,$2,$3)',[agent,instance,initial.revision])
        : second.query("SELECT identity.assistant_panel_commit($1,$2,'memory','race',$3,'save','{}',NULL,NULL,NULL,$4)",
          [agent,randomUUID(),initial.revision,action === 'publish' ? instance : null]))
        .then(() => ({ code: 'unexpected-success' }), (error: { code: string }) => ({ code: error.code }))
      await awaitFact('concurrent request waits on the assistant control row',async () => {
        const row = (await db.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',[pid])).rows[0]!
        return row.blocked ? true : undefined
      })
      await first.query('COMMIT')
      expect(await result).toEqual({ code: '40001' })
      await second.query('ROLLBACK')
      await db.query('BEGIN')
      const after = await snapshot()
      expect(after.revision).toBe(deletion.revision)
      expect(after.items[0]!.deleted_at).not.toBeNull()
      expect((await pending()).changes.map(c => c.operation_id)).toEqual([deletion.operationId])
      await db.query('COMMIT')
    } finally {
      await first.query('ROLLBACK').catch(() => undefined); await second.query('ROLLBACK').catch(() => undefined)
      await first.end(); await second.end()
      await db.query('ROLLBACK')
      await db.query('DELETE FROM chat.chats WHERE id=$1',[chat])
      await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[[owner,stranger]])
    }
  })

  it('serves the same saved state over the authenticated Data API while anonymous calls and table writes fail', async () => {
    await db.query('COMMIT')
    const endpoint = process.env.GUGU_INTEGRATION_SUPABASE_URL ?? ''
    if (!['127.0.0.1','localhost','[::1]'].includes(new URL(endpoint).hostname)) throw new Error('Panel API tests require the fixture API')
    const options = { auth: { persistSession: false,autoRefreshToken: false,detectSessionInUrl: false },db: { schema: 'identity' } }
    const admin = createClient(endpoint,process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY!,options)
    const client = createClient(endpoint,process.env.VITE_SUPABASE_ANON_KEY!,options)
    try {
      const password = randomUUID()
      expect((await admin.auth.admin.updateUserById(owner,{ password,email_confirm: true })).error).toBeNull()
      expect((await client.auth.signInWithPassword({ email: `${owner}@panel.invalid`,password })).error).toBeNull()
      const empty = await client.rpc('assistant_panel_snapshot',{ p_assistant: agent })
      expect(empty.error).toBeNull()
      expect(empty.data).toEqual({ version: 1,revision: '0',items: [],application: [] })
      const id = randomUUID()
      const input = { p_assistant: agent,p_operation_id: id,p_domain: 'personality',p_resource_key: 'current',
        p_expected_revision: '0',p_operation: 'save',p_data: { text: 'Saved through the panel API' } }
      const saved = await client.rpc('assistant_panel_commit',input)
      expect(saved.error).toBeNull()
      expect(saved.data).toMatchObject({ operationId: id,status: 'pending' })
      expect((await client.rpc('assistant_panel_commit',input)).data).toEqual(saved.data)
      const read = await client.rpc('assistant_panel_snapshot',{ p_assistant: agent })
      expect(read.error).toBeNull()
      expect(read.data.items[0].data).toEqual(input.p_data)
      expect((await client.from('assistant_panel_items').update({ data: {} }).eq('assistant_user_id',agent)).error?.code).toBe('42501')
      const anonymous = createClient(endpoint,process.env.VITE_SUPABASE_ANON_KEY!,options)
      expect((await anonymous.rpc('assistant_panel_snapshot',{ p_assistant: agent })).error?.code).toBe('42501')
    } finally {
      await client.auth.signOut()
      await db.query('DELETE FROM chat.chats WHERE id=$1',[chat])
      await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[[owner,stranger]])
    }
  })
})
