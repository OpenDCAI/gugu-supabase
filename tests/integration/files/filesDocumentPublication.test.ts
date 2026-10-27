import { createClient } from '@supabase/supabase-js'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Fixture, compactAware, filesConfig, getFile, machine, openPage, startFiles, waitFor, type Running } from './support.ts'

let fx: Fixture, svc: Running, user: string, token: string, group: string, outsider: string
const api = process.env.GUGU_INTEGRATION_SUPABASE_URL ?? ''
const anon = process.env.VITE_SUPABASE_ANON_KEY ?? ''
const serviceKey = process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY ?? ''
const password = randomUUID()
const admin = createClient(api, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(api).hostname)) throw new Error('Publication tests require the owned loopback API')
  const email = `${randomUUID()}@document-publication.invalid`
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (created.error || !created.data.user) throw new Error(created.error?.message ?? 'No fixture user')
  user = created.data.user.id
  const signed = await createClient(api, anon, { auth: { autoRefreshToken: false, persistSession: false } }).auth.signInWithPassword({ email, password })
  if (signed.error || !signed.data.session) throw new Error(signed.error?.message ?? 'No fixture session')
  token = signed.data.session.access_token
  fx = new Fixture(); await fx.connect()
  outsider = await fx.person('non-member publication recipient')
  group = await fx.group(user, [])
  const secret = process.env.GUGU_INTEGRATION_JWT_SECRET
  if (!secret) throw new Error('The owned fixture JWT verification key is missing')
  svc = await startFiles(filesConfig(await fx.filesLogin(), `${api}/auth/v1/.well-known/jwks.json`, {
    jwtSecret: new TextEncoder().encode(secret), supabaseUrl: api, anonKey: anon, compactDrainMs: 1000,
  }))
})
afterAll(async () => {
  await svc?.close()
  await fx?.cleanup()
  if (user) { const removed = await admin.auth.admin.deleteUser(user); if (removed.error) throw new Error(removed.error.message) }
})

async function upload(text: string, type = 'text/markdown') {
  const key = `staging/${user}/${randomUUID()}`
  const blob = (await fx.admin.query('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5)',
    [user, key, createHash('sha256').update(text).digest('hex'), Buffer.byteLength(text), type])).rows[0].blob_id as string
  // Inspected-byte registration is independently exercised by the Deno tests using the canonical classifier.
  await fx.admin.query('UPDATE chat.file_blob_uploads SET document=$2 WHERE staging_key=$1', [key, { text, content_type: type }])
  return { key, blob }
}
async function initial(text = '# original', type = 'text/markdown') {
  const original = await upload(text, type)
  const item = randomUUID()
  await fx.admin.query("INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,size_bytes,inline_text,blob_id,created_by) VALUES($1,$2,'document',$3,$4,$5,$6,$7,$8)", [item, group, type === 'application/json' ? 'document.json' : 'document.md', type, Buffer.byteLength(text), text, original.blob, user])
  await fx.admin.query('INSERT INTO chat.workspace_item_versions(item_id,n,inline_text,blob_id,content_type,size_bytes,made_by) VALUES($1,1,$2,$3,$4,$5,$6)', [item, text, original.blob, type, Buffer.byteLength(text), user])
  return { item, original }
}
async function publish(item: string, key: string, expected = 1, extra: Record<string, unknown> = {}) {
  return await operate(item, {
    fn: 'attachment_commit', args: { p_item_id: item, p_expected_version: expected, p_staging_key: key,
      p_chat_id: group, p_sender_user_id: user, p_file_name: 'document.md', p_message_id: randomUUID(), ...extra },
  })
}
async function operate(item: string, publication: Record<string, unknown>) {
  const response = await fetch(`${svc.url}/${item}/edit`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ publication }) })
  return { status: response.status, body: await response.json() }
}

describe('document publication through the restricted file service and original JWT Data API', () => {
  it('publishes one new body/message atomically and preserves the original immutable body', async () => {
    const { item, original } = await initial()
    const host = machine(svc.url, token), page = openPage(host, item, 0)
    compactAware(page); await page.synced
    try {
      const next = await upload('# edited')
      const message = randomUUID()
      expect(await publish(item, next.key, 1, { p_message_id: message })).toMatchObject({ status: 200 })
      expect((await fx.admin.query('SELECT version,epoch,inline_text FROM chat.workspace_items WHERE id=$1', [item])).rows[0]).toEqual({ version: 2, epoch: 1, inline_text: '# edited' })
      expect((await fx.admin.query('SELECT file_item_id,file_version FROM chat.messages WHERE id=$1', [message])).rows[0]).toEqual({ file_item_id: item, file_version: 2 })
      expect((await fx.admin.query('SELECT blob_id,inline_text FROM chat.workspace_item_versions WHERE item_id=$1 AND n=1', [item])).rows[0]).toEqual({ blob_id: original.blob, inline_text: '# original' })
      expect(await waitFor(() => page.events.closed !== null)).toBeGreaterThanOrEqual(0)
      expect(page.events.closed!.reason).toBe('compacted:1')
    } finally { page.close(); host.socket.destroy() }
  })

  it('a message failure resumes the unchanged live document and revokes the unused preparation', async () => {
    const { item } = await initial()
    const host = machine(svc.url, token), page = openPage(host, item, 0)
    const paused = compactAware(page); await page.synced
    try {
      const next = await upload('# rolled back')
      const failed = await publish(item, next.key, 1, { p_to_user_ids: [outsider] })
      expect(failed.status).toBeGreaterThanOrEqual(400)
      expect((await fx.admin.query('SELECT version,epoch,inline_text FROM chat.workspace_items WHERE id=$1', [item])).rows[0]).toEqual({ version: 1, epoch: 0, inline_text: '# original' })
      expect(await waitFor(() => paused.resume > 0)).toBeGreaterThanOrEqual(0)
      expect(page.events.closed).toBeNull()
      expect((await fx.admin.query("SELECT document ? 'prepared' AS prepared FROM chat.file_blob_uploads WHERE staging_key=$1", [next.key])).rows[0]).toEqual({ prepared: false })
      page.doc.getText('content').insert(0, 'resumed ')
      expect(await waitFor(async () => (await getFile(svc.url, token, item)).body.text === 'resumed # original')).toBeGreaterThanOrEqual(0)
    } finally { page.close(); host.socket.destroy() }
  })

  it('an unsaved concurrent edit rejects a replacement without creating a message or losing the edit', async () => {
    const { item } = await initial()
    const host = machine(svc.url, token), page = openPage(host, item, 0)
    compactAware(page); await page.synced
    try {
      page.doc.getText('content').insert(0, 'unsaved ')
      expect(await waitFor(async () => (await getFile(svc.url, token, item)).body.text === 'unsaved # original')).toBeGreaterThanOrEqual(0)
      const next = await upload('# external edit'), message = randomUUID()
      expect(await publish(item, next.key, 1, { p_message_id: message })).toMatchObject({ status: 409, body: { error: 'content-changed' } })
      expect((await getFile(svc.url, token, item)).body.text).toBe('unsaved # original')
      expect((await fx.admin.query('SELECT id FROM chat.messages WHERE id=$1', [message])).rows).toEqual([])
      expect(page.events.closed).toBeNull()
    } finally { page.close(); host.socket.destroy() }
  })

  it('sending the same content twice keeps one version number', async () => {
    const { item } = await initial()
    for (let epoch = 0; epoch < 2; epoch++) {
      const host = machine(svc.url, token), page = openPage(host, item, epoch)
      compactAware(page); await page.synced
      try {
        const copy = await upload('# original')
        expect(await publish(item, copy.key)).toMatchObject({ status: 200 })
      } finally { page.close(); host.socket.destroy() }
    }
    expect((await fx.admin.query('SELECT n FROM chat.workspace_item_versions WHERE item_id=$1 ORDER BY n', [item])).rows).toEqual([{ n: 1 }])
    expect((await fx.admin.query('SELECT file_version FROM chat.messages WHERE file_item_id=$1 ORDER BY seq', [item])).rows).toEqual([{ file_version: 1 }, { file_version: 1 }])
  })

  it('a cross-chat share of a new JSON document keeps its cooperative text representation and pinned content', async () => {
    const text = '{"text":{"$text":"before"},"list":[{"$text":"nested"}]}'
    const item = await fx.file(group, user, 'new.json', 'application/json', text)
    const host = machine(svc.url, token), page = openPage(host, item, 0)
    compactAware(page); await page.synced
    try {
      const exported = await fetch(`${svc.url}/${item}?format=file`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      expect(JSON.parse(exported.text)).toEqual(JSON.parse(text))
      const copy = await upload(exported.text, 'application/json')
      const target = await fx.group(user, []), message = randomUUID()
      expect(await operate(item, { fn: 'attachment_share', snapshot: true, args: {
        p_item_id: item, p_version: 1, p_staging_key: copy.key, p_message_id: message, p_chat_id: target, p_sender_user_id: user,
      } })).toMatchObject({ status: 200 })
      const sent = (await fx.admin.query('SELECT file_item_id,file_version FROM chat.messages WHERE id=$1', [message])).rows[0]
      expect(sent.file_item_id).not.toBe(item)
      expect(sent.file_version).toBe(1)
      expect((await fx.admin.query('SELECT kind FROM chat.workspace_items WHERE id=$1', [sent.file_item_id])).rows[0]).toEqual({ kind: 'document' })
      const copiedHost = machine(svc.url, token), copiedPage = openPage(copiedHost, sent.file_item_id, 0)
      try {
        await copiedPage.synced
        expect(copiedPage.doc.getMap('root').get('text')).toBeInstanceOf(Y.Text)
        expect((copiedPage.doc.getMap('root').get('list') as Y.Array<Y.Text>).get(0)).toBeInstanceOf(Y.Text)
        expect(copiedPage.doc.getMap('root').toJSON()).toEqual({ text: 'before', list: ['nested'] })
      } finally { copiedPage.close(); copiedHost.socket.destroy() }
    } finally { page.close(); host.socket.destroy() }
  })

  it('JSON replacement retains Y.Text after the swap and identical readable content does not create another version', async () => {
    const type = 'application/json'
    const { item } = await initial('{"text":{"$text":"before"}}', type)
    for (let epoch = 0; epoch < 2; epoch++) {
      const host = machine(svc.url, token), page = openPage(host, item, epoch)
      compactAware(page); await page.synced
      try {
        expect(page.doc.getMap('root').get('text')).toBeInstanceOf(Y.Text)
        const next = await upload('{\n "text": "after"\n}', type)
        expect(await publish(item, next.key, epoch === 0 ? 1 : 2)).toMatchObject({ status: 200 })
      } finally { page.close(); host.socket.destroy() }
    }
    expect((await fx.admin.query('SELECT version FROM chat.workspace_items WHERE id=$1', [item])).rows[0]).toEqual({ version: 2 })
    const exported = await fetch(`${svc.url}/${item}?format=file`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
    expect(JSON.parse(exported.text)).toEqual({ text: { $text: 'after' } })
  })
})
