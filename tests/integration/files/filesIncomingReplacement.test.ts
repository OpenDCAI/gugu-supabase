import { createClient } from '@supabase/supabase-js'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Fixture, compactAware, filesConfig, getFile, machine, openPage, startFiles, waitFor, type Running } from './support.ts'

let fx: Fixture, svc: Running, user: string, token: string, group: string, outsider: string
const api = process.env.GUGU_INTEGRATION_SUPABASE_URL ?? ''
const anon = process.env.VITE_SUPABASE_ANON_KEY ?? ''
const admin = createClient(api, process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY ?? '', { auth: { autoRefreshToken: false, persistSession: false } })
let caller: ReturnType<typeof createClient>
beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(api).hostname)) throw Error('Owned loopback only')
  const email = `${randomUUID()}@incoming-document.invalid`, password = randomUUID()
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (created.error) throw created.error
  user = created.data.user!.id
  caller = createClient(api, anon, { db: { schema: 'chat' }, auth: { autoRefreshToken: false, persistSession: false } })
  const login = await caller.auth.signInWithPassword({ email, password })
  if (login.error) throw login.error
  token = login.data.session!.access_token
  fx = new Fixture(); await fx.connect()
  group = await fx.group(user, []); outsider = await fx.person('not a member')
  svc = await startFiles(filesConfig(await fx.filesLogin(), `${api}/auth/v1/.well-known/jwks.json`, { compactDrainMs: 300 }))
})
afterAll(async () => {
  await svc?.close(); await fx?.cleanup()
  if (user) { const removed = await admin.auth.admin.deleteUser(user); if (removed.error) throw removed.error }
})
async function upload(text: string, type = 'text/markdown') {
  const key = `staging/${user}/${randomUUID()}`
  const blob = (await fx.admin.query('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5)',
    [user, key, createHash('sha256').update(text).digest('hex'), Buffer.byteLength(text), type])).rows[0].blob_id as string
  await fx.admin.query('UPDATE chat.file_blob_uploads SET document=$2 WHERE staging_key=$1', [key, { text, content_type: type }])
  return { key, blob }
}
async function initial(text = '# original', type = 'text/markdown') {
  const original = await upload(text, type), item = randomUUID()
  await fx.admin.query("INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,size_bytes,inline_text,blob_id,created_by) VALUES($1,$2,'document','document.md',$3,$4,$5,$6,$7)", [item, group, type, Buffer.byteLength(text), text, original.blob, user])
  await fx.admin.query('INSERT INTO chat.workspace_item_versions(item_id,n,inline_text,blob_id,content_type,size_bytes,made_by) VALUES($1,1,$2,$3,$4,$5,$6)', [item, text, original.blob, type, Buffer.byteLength(text), user])
  return { item, original }
}
async function stage(item: string, key: string, finish = false, expected = 1) {
  const response = await fetch(`${svc.url}/${item}/replace`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ key, expected, finish }) })
  return { status: response.status, body: await response.json() }
}
const args = (item: string, key: string, expected = 1) => ({ p_item_id: item, p_expected_version: expected, p_staging_key: key,
  p_chat_id: group, p_sender_user_id: user, p_file_name: 'document.md', p_message_id: randomUUID() })
async function replace(item: string, key: string, extra = {}, expected = 1) {
  const ready = await stage(item, key, false, expected)
  if (ready.status !== 200) return { ready, error: null }
  try { return { ready, ...await caller.rpc('attachment_commit', { ...args(item, key, expected), ...extra }) } }
  finally { await stage(item, key, true, expected) }
}
async function resumeSeen(item: string, key: string, seen: { resume: number }) {
  expect(await waitFor(() => seen.resume > 0)).toBeGreaterThanOrEqual(0)
  expect((await fx.row(item))!.epoch).toBe(0)
  expect((await fx.admin.query("SELECT document ? 'prepared' AS prepared FROM chat.file_blob_uploads WHERE staging_key=$1", [key])).rows[0].prepared).toBe(false)
}

describe('incoming document copies retain the original caller-JWT attachment transaction', () => {
  it('a non-member cannot send a document reference as a message', async () => {
    const { item } = await initial()
    await fx.admin.query('BEGIN; SET LOCAL ROLE authenticated')
    try {
      await fx.admin.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: outsider, role: 'authenticated' })])
      await expect(fx.admin.query('SELECT * FROM chat.attachment_share($1,1,$2,$3,$4)', [item, randomUUID(), group, outsider]))
        .rejects.toMatchObject({ hint: 'workspace_not_member' })
    } finally { await fx.admin.query('ROLLBACK') }
  })
  it('commits the next body and reopens the mounted editor; the old generation cannot overwrite it', async () => {
    const { item, original } = await initial(), next = await upload('# next')
    const host = machine(svc.url, token), page = openPage(host, item, 0)
    compactAware(page); await page.synced
    try {
      const message = randomUUID(), result = await replace(item, next.key, { p_message_id: message })
      expect(result.ready.status).toBe(200); expect(result.error).toBeNull()
      const replay = await replace(item, next.key, { p_message_id: message })
      expect(replay.ready.status).toBe(200); expect(replay.error).toBeNull()
      expect((await fx.admin.query("SELECT document->'prepared' ? 'state' AS state FROM chat.file_blob_uploads WHERE staging_key=$1", [next.key])).rows[0].state).toBe(false)
      expect(await waitFor(() => page.events.closed?.reason === 'compacted:1')).toBeGreaterThanOrEqual(0)
      const reopened = openPage(host, item, 1); await reopened.synced
      try {
        expect(reopened.text()).toBe('# next')
        page.doc.getText('content').insert(0, 'old state must stay retired ')
        reopened.doc.getText('content').insert(0, 'new editor ')
        expect(await waitFor(async () => (await fx.row(item))!.inline_text === 'new editor # next')).toBeGreaterThanOrEqual(0)
        expect((await getFile(svc.url, token, item)).body.text).toBe('new editor # next')
        expect((await fx.admin.query('SELECT blob_id,inline_text FROM chat.workspace_item_versions WHERE item_id=$1 AND n=1', [item])).rows[0]).toEqual({ blob_id: original.blob, inline_text: '# original' })
      } finally { reopened.close() }
    } finally { page.close(); host.socket.destroy() }
  })
  it('an unsaved edit returns 409, resumes providers, and leaves the concurrent text intact', async () => {
    const { item } = await initial(), next = await upload('# incoming')
    const host = machine(svc.url, token), page = openPage(host, item, 0), seen = compactAware(page)
    await page.synced
    try {
      page.doc.getText('content').insert(0, 'unsaved ')
      expect(await waitFor(async () => (await getFile(svc.url, token, item)).body.text === 'unsaved # original')).toBeGreaterThanOrEqual(0)
      expect(await stage(item, next.key)).toMatchObject({ status: 409, body: { error: 'content-changed' } })
      expect(await waitFor(() => seen.resume > 0)).toBeGreaterThanOrEqual(0)
      expect((await getFile(svc.url, token, item)).body.text).toBe('unsaved # original')
    } finally { page.close(); host.socket.destroy() }
  })
  it('a failed original message transaction releases pause and invalidates a delayed commit', async () => {
    const { item } = await initial(), next = await upload('# rejected')
    const host = machine(svc.url, token), page = openPage(host, item, 0), seen = compactAware(page)
    await page.synced
    try {
      const result = await replace(item, next.key, { p_to_user_ids: [outsider] })
      expect(result.ready.status).toBe(200); expect(result.error).not.toBeNull()
      await resumeSeen(item, next.key, seen)
      const late = await caller.rpc('attachment_commit', args(item, next.key))
      expect(late.error?.hint).toBe('workspace_version_conflict')
      expect((await getFile(svc.url, token, item)).body.text).toBe('# original')
    } finally { page.close(); host.socket.destroy() }
  })
  it('a provider that cannot drain times out, releases every pause and never authorizes replacement', async () => {
    const { item } = await initial(), next = await upload('# blocked')
    const host = machine(svc.url, token), page = openPage(host, item, 0), seen = compactAware(page, { respond: false })
    await page.synced
    try {
      expect((await stage(item, next.key)).status).toBeGreaterThanOrEqual(400)
      await resumeSeen(item, next.key, seen)
      page.doc.getText('content').insert(0, 'still editable ')
      expect(await waitFor(async () => (await getFile(svc.url, token, item)).body.text === 'still editable # original')).toBeGreaterThanOrEqual(0)
    } finally { page.close(); host.socket.destroy() }
  })
  it('an abandoned prepared request expires, releases pause and refuses the late original transaction', async () => {
    const { item } = await initial(), next = await upload('# abandoned')
    const host = machine(svc.url, token), page = openPage(host, item, 0), seen = compactAware(page)
    await page.synced
    try {
      expect((await stage(item, next.key)).status).toBe(200)
      expect(await waitFor(() => seen.resume > 0, 40_000, 100)).toBeGreaterThanOrEqual(0)
      await resumeSeen(item, next.key, seen)
      const late = await caller.rpc('attachment_commit', args(item, next.key))
      expect(late.error?.hint).toBe('workspace_version_conflict')
      expect((await getFile(svc.url, token, item)).body.text).toBe('# original')
    } finally { page.close(); host.socket.destroy() }
  }, 60_000)
  it('the database refuses an expired preparation even before the file service cancellation arrives', async () => {
    const { item } = await initial(), next = await upload('# too late')
    const host = machine(svc.url, token), page = openPage(host, item, 0), seen = compactAware(page)
    await page.synced
    try {
      expect((await stage(item, next.key)).status).toBe(200)
      await fx.admin.query("UPDATE chat.file_blob_uploads SET document=jsonb_set(document,'{prepared,expires}',to_jsonb(clock_timestamp()-interval '1 second')) WHERE staging_key=$1", [next.key])
      expect((await caller.rpc('attachment_commit', args(item, next.key))).error?.hint).toBe('workspace_version_conflict')
      await stage(item, next.key, true)
      await resumeSeen(item, next.key, seen)
    } finally { page.close(); host.socket.destroy() }
  })
  it('the same incoming bytes do not create another version; JSON collaborative text retains its identity', async () => {
    const { item } = await initial('{"text":{"$text":"before"}}', 'application/json')
    const next = await upload('{"text":"after"}', 'application/json')
    const host = machine(svc.url, token), page = openPage(host, item, 0)
    compactAware(page); await page.synced
    try {
      expect(page.doc.getMap('root').get('text')).toBeInstanceOf(Y.Text)
      expect((await replace(item, next.key)).error).toBeNull()
      const reopened = openPage(host, item, 1); compactAware(reopened); await reopened.synced
      try {
        expect(reopened.doc.getMap('root').get('text')).toBeInstanceOf(Y.Text)
        const same = await upload('{"text":"after"}', 'application/json')
        expect((await replace(item, same.key, {}, 2)).error).toBeNull()
        expect((await fx.admin.query('SELECT version FROM chat.workspace_items WHERE id=$1', [item])).rows[0].version).toBe(2)
      } finally { reopened.close() }
    } finally { page.close(); host.socket.destroy() }
  })
  it('a transaction admitted before expiry cannot commit after expiry', async () => {
    const { item } = await initial(), next = await upload('# delayed transaction')
    const host = machine(svc.url, token), page = openPage(host, item, 0), seen = compactAware(page)
    await page.synced
    try {
      expect((await stage(item, next.key)).status).toBe(200)
      await fx.admin.query("UPDATE chat.file_blob_uploads SET document=jsonb_set(document,'{prepared,expires}',to_jsonb(clock_timestamp()+interval '5 seconds')) WHERE staging_key=$1", [next.key])
      await fx.admin.query('BEGIN; SET LOCAL ROLE authenticated')
      await fx.admin.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
      await fx.admin.query('SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5,$6,NULL,NULL,false,false,NULL,NULL,$7,1)', [next.key, randomUUID(), group, user, 'document.md', [], item])
      await fx.admin.query('RESET ROLE')
      await fx.admin.query("SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (document->'prepared'->>'expires')::timestamptz-clock_timestamp()))+0.01) FROM chat.file_blob_uploads WHERE staging_key=$1", [next.key])
      await expect(fx.admin.query('COMMIT')).rejects.toMatchObject({ hint: 'workspace_version_conflict' })
      await stage(item, next.key, true)
      await resumeSeen(item, next.key, seen)
      expect((await getFile(svc.url, token, item)).body.text).toBe('# original')
    } finally { await fx.admin.query('ROLLBACK'); page.close(); host.socket.destroy() }
  }, 20_000)
})
