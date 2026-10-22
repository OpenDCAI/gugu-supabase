import { createFixtureGroup } from '../../support/groupFixture'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 附件消息那一半(迁移 *_attachment_publisher_whisper_pinned_bytes;gugu#7290 gugu-2,统筹 161 10-16 定,安全复核 gugu-base f2c58a626):
 * 钉住的那一版字节不变;悄悄话附件直接指字节;agent 收件拿到指针。App 包的发布者就是消息的发送者(迁移 *_attachment_publisher_is_sender,
 * owner 10-17):库里不另记一列、不沿转发链抄。
 * 每条否定配正对照;每条用例 BEGIN…ROLLBACK。
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient
let owner: string
let member: string
let outsider: string
let agent: string

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asServiceRole() {
  await database.query('SET LOCAL role TO service_role')
}
async function asOwner() {
  await database.query('RESET role')
}
async function fails(sql: string, values: unknown[] = []): Promise<string> {
  await database.query('SAVEPOINT expected_failure')
  try {
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT expected_failure')
    const e = error as Error & { hint?: string; code?: string }
    return `${e.message} | hint: ${e.hint ?? ''} | code: ${e.code ?? ''}`
  }
  await database.query('RELEASE SAVEPOINT expected_failure')
  throw new Error(`expected failure, but succeeded: ${sql}`)
}
async function human(name: string): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@message-file-publisher.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'message-file-publisher fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}
async function agentOf(ownerId: string, name: string): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, agent_public, device_id)
    VALUES ($1,'agent',$2,$3,true,$4)`, [id, name, ownerId, `dev-${ownerId}`])
  return id
}
async function newGroup(creator: string, initial: string[]): Promise<string> {
  const id = randomUUID()
  await asUser(creator)
  await createFixtureGroup(database, [
    id, 'Message file publisher', creator, JSON.stringify(initial.map((user_id) => ({ user_id, role: 'member' }))),
  ])
  await asOwner()
  return id
}
/** A chat of another kind ('ai', 'dm'), or a group whose members are put in directly, as the server does. */
async function chatOf(kind: 'ai' | 'dm' | 'group', members: string[]): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,$2,NULL,$3)`, [id, kind, members[0]])
  // A group needs its one human owner (a deferred check): the first one.
  for (const [i, user] of members.entries()) {
    await database.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,$3)`, [id, user, kind === 'group' && i === 0 ? 'owner' : 'member'])
  }
  return id
}
async function object(chatId: string, by: string, name = 'deck.pptx'): Promise<string> {
  const pointer = `${chatId}/${by}/${randomUUID()}-${name}`
  await asOwner()
  await database.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('workspace',$1)`, [pointer])
  return pointer
}
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
/** A binary made by `by` (a pointer, a 'workspace' blob; written directly, as the server): its item. */
async function binary(chatId: string, by: string): Promise<string> {
  const pointer = await object(chatId, by)
  await asOwner()
  const { rows } = await database.query<{ id: string }>(
    `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, blob_id, size_bytes, source_message_ids, created_by, version)
     VALUES ($1,'file','deck.pptx',$2,chat.file_blob_for_pointer($3,100,$2,$4),100,'{}',$4,1) RETURNING id`, [chatId, PPTX, pointer, by])
  await asOwner()
  return rows[0]!.id
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
/** What the attachments function does once it has read the bytes: an upload registered for `by` (service_role). */
async function upload(by: string, content: string, type = 'image/png', size = 1234): Promise<{ key: string; blob: string }> {
  const key = `staging/${by}/${randomUUID()}`
  await asServiceRole()
  const { rows } = await database.query<{ blob_id: string }>('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5,$6,$7)', [by, key, sha(content), size, type, 640, 480])
  await asOwner()
  return { key, blob: rows[0]!.blob_id }
}
type Message = { id: string; chat_id: string; sender_user_id: string; content: string; content_type: string; file_item_id: string | null; file_version: number | null; forwarded_from_message_id: string | null }
const COMMIT = 'SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5,$6,NULL,NULL,false,$7)'
async function commit(caller: string, key: string, messageId: string, chatId: string, sender: string, name: string, opts: { to?: string[]; whisper?: boolean } = {}): Promise<Message> {
  await asUser(caller)
  const { rows } = await database.query<Message>(COMMIT, [key, messageId, chatId, sender, name, opts.to ?? [], opts.whisper ?? false])
  await asOwner()
  return rows[0]!
}
type Item = { id: string; chat_id: string; parent_id: string | null; filename: string; kind: string; blob_id: string | null; pointer: string | null; created_by: string; source_message_ids: string[]; version: number; size_bytes: string; content_type: string }
async function item(id: string): Promise<Item> {
  await asOwner()
  return (await database.query<Item>('SELECT id, chat_id, parent_id, filename, kind, blob_id, chat.file_blob_pointer(blob_id) AS pointer, created_by, source_message_ids, version, size_bytes, content_type FROM chat.workspace_items WHERE id = $1', [id])).rows[0]!
}
async function attachmentsFolder(chatId: string): Promise<string | null> {
  await asOwner()
  return (await database.query<{ id: string }>(`SELECT id FROM chat.workspace_items WHERE chat_id = $1 AND system_role = 'attachments'`, [chatId])).rows[0]?.id ?? null
}
async function inAttachments(chatId: string): Promise<string[]> {
  const folder = await attachmentsFolder(chatId)
  if (!folder) return []
  return (await database.query<{ filename: string }>('SELECT filename FROM chat.workspace_items WHERE parent_id = $1 ORDER BY filename', [folder])).rows.map((r) => r.filename)
}
async function consumed(key: string): Promise<string | null> {
  await asOwner()
  return (await database.query<{ message_id: string | null }>('SELECT message_id FROM chat.file_blob_uploads WHERE staging_key = $1', [key])).rows[0]!.message_id
}
const envelope = (name: string, type: string, size: number) =>
  `[附件] ${name} (${type})\n[Size] ${size}\n[Kind] ${type.startsWith('image/') ? 'image' : 'file'}`
const SEND = 'SELECT * FROM chat.send_message_idempotent($1,$2,$3,$4,$5,$6,NULL,NULL,false,false,NULL,$7,$8,NULL)'

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('messagePinnedBytesWhisper.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human('Owner')
  member = await human('Member')
  outsider = await human('Outsider')
  agent = await agentOf(owner, 'Owner Agent')
})
afterEach(async () => {
  if (!database) return
  try {
    await asOwner()
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await database.query('ROLLBACK')
  }
})

const FORWARD = 'SELECT * FROM chat.attachment_forward($1,$2,$3,$4)'
async function forward(caller: string, sourceId: string, chatId: string): Promise<Message> {
  await asUser(caller)
  const { rows } = await database.query<Message>(FORWARD, [sourceId, randomUUID(), chatId, caller])
  await asOwner()
  return rows[0]!
}
/** 一个包:同样的字节可以被不同的人各传一次(按内容去重成同一个 blob)。 */
const PACKAGE = 'application/x-gugu-extension'
async function send(by: string, chatId: string, bytes: string, name = 'tool.guguext'): Promise<Message> {
  const up = await upload(by, bytes, PACKAGE)
  return commit(by, up.key, randomUUID(), chatId, by, name)
}

describe('消息钉住的那一版,字节不变(复核要改 1)', () => {
  async function replaceAs(by: string, itemId: string, chatId: string): Promise<{ version: number; pointer: string }> {
    const pointer = await object(chatId, by, 'deck-v2.pptx')
    await asUser(by)
    const { rows } = await database.query<{ version: number; pointer: string }>(
      'SELECT version, pointer FROM chat.workspace_replace_file_as($1,$2,$3,$4,NULL,NULL)', [itemId, by, pointer, 200])
    await asOwner()
    return rows[0]!
  }
  async function pinned(itemId: string, version: number): Promise<string> {
    await asOwner()
    return (await database.query<{ b: string }>('SELECT chat.workspace_version_blob($1,$2) AS b', [itemId, version])).rows[0]!.b
  }

  it('成员直接改条目(blob_id / version / content_type / source_message_ids / updated_at / filename):自己的、别人的都是 permission denied', async () => {
    const group = await newGroup(owner, [member])
    const own = await binary(group, member)
    const others = await binary(group, owner)
    await asUser(member)
    for (const id of [own, others]) {
      for (const [column, value] of [['blob_id', randomUUID()], ['version', 7], ['content_type', 'text/plain'], ['source_message_ids', '{x}'], ['updated_at', '2020-01-01'], ['filename', 'renamed.pptx']] as const) {
        expect(await fails(`UPDATE chat.workspace_items SET ${column} = $1 WHERE id = $2`, [value, id])).toMatch(/permission denied/)
      }
    }
    // 对照:改名经门照常。
    await database.query('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3)', [own, member, 'renamed.pptx'])
    expect((await item(own)).filename).toBe('renamed.pptx')
  })

  it('经 workspace_replace_file_as 换内容照常成功、升版本;钉在第 1 版的消息仍指旧字节', async () => {
    const group = await newGroup(owner, [member])
    const id = await binary(group, owner)
    const before = await pinned(id, 1)
    await asOwner()
    const env = (await database.query<{ e: string }>('SELECT chat.workspace_version_envelope($1, 1) AS e', [id])).rows[0]!.e
    await asUser(owner)
    const sent = (await database.query<Message>(SEND, [randomUUID(), group, owner, [], env, 'attachment', id, 1])).rows[0]!
    const after = await replaceAs(member, id, group)
    expect(after.version).toBe(2)
    expect(await pinned(id, 1)).toBe(before)
    expect(await pinned(id, 2)).not.toBe(before)
    expect(sent.file_version).toBe(1)
  })

  it('改名、移动(只升版本、不写历史)以后,钉住的那一版仍有那份字节:条目那一种签得到,收件人转发得了', async () => {
    const group = await newGroup(owner, [member])
    const other = await newGroup(member, [outsider])
    const sent = await send(owner, group, `pkg-${randomUUID()}`)
    const blob = await pinned(sent.file_item_id!, 1)
    await asUser(member)
    await database.query('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3)', [sent.file_item_id, member, 'renamed.guguext'])
    await database.query('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3)', [sent.file_item_id, member, 'again.guguext'])
    await asOwner()
    expect((await item(sent.file_item_id!)).version).toBe(3)
    expect(await pinned(sent.file_item_id!, 1)).toBe(blob)
    await asUser(member)
    const { rows } = await database.query<{ version: number; current_version: number }>(
      'SELECT version, current_version FROM chat.file_urls_as($1::jsonb, $2)', [JSON.stringify([{ item_id: sent.file_item_id, version: 1 }]), member])
    expect(rows).toEqual([{ version: 1, current_version: 3 }])
    await asOwner()
    const moved = await forward(member, sent.id, other)
    expect((await item(moved.file_item_id!)).blob_id).toBe(blob)
  })

  it('definer 的路也改不了:blob_id 变了而版本没升 ⇒ 拒;历史里某一版的字节不能改;升了版本 ⇒ 可以', async () => {
    const group = await newGroup(owner, [member])
    const id = await binary(group, owner)
    await replaceAs(owner, id, group)
    await asOwner()
    const otherBlob = (await database.query<{ b: string }>('SELECT blob_id AS b FROM chat.workspace_items WHERE id = $1', [await binary(group, member)])).rows[0]!.b
    expect(await fails('UPDATE chat.workspace_items SET blob_id = $1 WHERE id = $2', [otherBlob, id])).toMatch(/hint: workspace_version_bytes_fixed/)
    expect(await fails('UPDATE chat.workspace_item_versions SET blob_id = $1 WHERE item_id = $2 AND n = 1', [otherBlob, id])).toMatch(/hint: workspace_version_bytes_fixed/)
    // 对照:同一句带上升版本就过(workspace_replace_file_as 就是这样),只改名字不碰字节也过。
    await database.query('UPDATE chat.workspace_items SET blob_id = $1, version = version + 1 WHERE id = $2', [otherBlob, id])
    expect((await item(id)).version).toBe(3)
    await database.query(`UPDATE chat.workspace_items SET filename = 'n.pptx' WHERE id = $1`, [id])
  })
})

describe('悄悄话的附件:不进群文件夹,消息直接指字节,读得到这条消息的人才签得到', () => {
  let third: string
  beforeEach(async () => { third = await human('Third') })
  type Row = Message & { file_blob_id: string | null; is_whisper: boolean }
  async function whisper(by: string, chatId: string, to: string[], bytes = `doc-${randomUUID()}`, name = 'secret.pdf'): Promise<{ sent: Row; blob: string; key: string }> {
    const up = await upload(by, bytes, 'application/pdf', 4321)
    const sent = (await commit(by, up.key, randomUUID(), chatId, by, name, { to, whisper: true })) as Row
    return { sent, blob: up.blob, key: up.key }
  }
  async function urls(as: string, refs: unknown[]): Promise<{ message_id: string | null; item_id: string | null; file_name: string; current_version: number | null }[]> {
    await asUser(as)
    const { rows } = await database.query<{ message_id: string | null; item_id: string | null; file_name: string; current_version: number | null }>(
      'SELECT * FROM chat.file_urls_as($1::jsonb, $2)', [JSON.stringify(refs), as])
    await asOwner()
    return rows
  }
  async function forwardAs(caller: string, sourceId: string, chatId: string, whisperTo?: string[]): Promise<Row> {
    await asUser(caller)
    const { rows } = await database.query<Row>('SELECT * FROM chat.attachment_forward($1,$2,$3,$4,$5,NULL,false,$6)',
      [sourceId, randomUUID(), chatId, caller, whisperTo ?? [], whisperTo !== undefined])
    await asOwner()
    return rows[0]!
  }

  it('提交:消息指那份字节,群文件夹里什么都没有;正文是带名字的信封;视图里有 file_blob_id', async () => {
    const group = await newGroup(owner, [member, third])
    const { sent, blob, key } = await whisper(owner, group, [member])
    expect(sent).toMatchObject({ is_whisper: true, file_item_id: null, file_version: null, file_blob_id: blob })
    expect(sent.content).toBe(envelope('secret.pdf', 'application/pdf', 4321))
    expect(await inAttachments(group)).toEqual([])
    expect(await consumed(key)).toBe(sent.id)
    // 对照:同一个群里不是悄悄话的附件照旧进「附件」。
    const up = await upload(owner, `open-${randomUUID()}`, 'application/pdf', 99)
    await commit(owner, up.key, randomUUID(), group, owner, 'open.pdf')
    expect(await inAttachments(group)).toEqual(['open.pdf'])
  })

  it('签链接按消息要:收发两边签得到(带名字),同群的第三人、撤回以后都签不到;条目那一种回 current_version', async () => {
    const group = await newGroup(owner, [member, third])
    const { sent } = await whisper(owner, group, [member])
    expect((await urls(owner, [{ message_id: sent.id }])).map((r) => [r.message_id, r.file_name])).toEqual([[sent.id, 'secret.pdf']])
    expect((await urls(member, [{ message_id: sent.id }])).length).toBe(1)
    expect(await urls(third, [{ message_id: sent.id }])).toEqual([])
    const open = await send(owner, group, `pkg-${randomUUID()}`)
    expect((await urls(third, [{ item_id: open.file_item_id, version: open.file_version }])).map((r) => [r.item_id, r.current_version])).toEqual([[open.file_item_id, 1]])
    await asOwner()
    await database.query('UPDATE chat.messages SET retracted_at = now() WHERE id = $1', [sent.id])
    expect(await urls(member, [{ message_id: sent.id }])).toEqual([])
  })

  it('字节的来路:直接插一条指别人字节的悄悄话 ⇒ 拒;伪造 forwarded_from 指自己读不到的悄悄话 ⇒ 拒;读得到的 ⇒ 过', async () => {
    const group = await newGroup(owner, [member, third])
    const { sent, blob } = await whisper(owner, group, [member])
    const INSERT = `INSERT INTO chat.messages (id, chat_id, sender_user_id, to_user_ids, content, content_type, is_whisper, file_blob_id, forwarded_from_message_id)
      VALUES ($1,$2,$3,$4,$5,'attachment',true,$6,$7)`
    await asUser(third)
    expect(await fails(INSERT, [randomUUID(), group, third, [owner], sent.content, blob, null])).toMatch(/hint: message_file_not_here/)
    expect(await fails(INSERT, [randomUUID(), group, third, [owner], sent.content, blob, sent.id])).toMatch(/hint: message_file_not_here/)
    await asUser(member)
    await database.query(INSERT, [randomUUID(), group, member, [owner], sent.content, blob, sent.id])
    // 发的人撤回以后,收件人也不能再「转发自它」把字节带出来(attachment_forward、/urls 同样拒)。
    const later = await whisper(owner, group, [member])
    await asUser(owner)
    await database.query('UPDATE chat.messages SET retracted_at = now() WHERE id = $1', [later.sent.id])
    await asUser(member)
    expect(await fails(INSERT, [randomUUID(), group, member, [owner], later.sent.content, later.blob, later.sent.id])).toMatch(/hint: message_file_not_here/)
    // 正文要是这份字节的信封。
    expect(await fails(INSERT, [randomUUID(), group, member, [owner], envelope('x.pdf', 'application/pdf', 1), blob, sent.id])).toMatch(/hint: message_file_envelope/)
    await asOwner()
  })

  it('转发:不是收件人 ⇒ 拒;收件人转进普通群 ⇒ 目标「附件」里建条目、同一个 blob;转成悄悄话 ⇒ 指同一份字节', async () => {
    const group = await newGroup(owner, [member, third])
    const other = await newGroup(member, [outsider])
    const { sent, blob } = await whisper(owner, group, [member])
    await asUser(third)
    expect(await fails('SELECT * FROM chat.attachment_forward($1,$2,$3,$4)', [sent.id, randomUUID(), other, third])).toMatch(/hint: attachment_source_not_found/)
    const open = await forwardAs(member, sent.id, other)
    expect(open).toMatchObject({ file_blob_id: null, forwarded_from_message_id: sent.id })
    expect((await item(open.file_item_id!)).blob_id).toBe(blob)
    expect(await inAttachments(other)).toEqual(['secret.pdf'])
    const again = await forwardAs(member, sent.id, other, [outsider])
    expect(again).toMatchObject({ is_whisper: true, file_item_id: null, file_blob_id: blob })
    expect(again.content).toBe(sent.content)
    expect(await inAttachments(other)).toEqual(['secret.pdf'])
  })

  it('回收:上传登记没了、只剩消息指着 ⇒ 还在用;撤回了也还在用;消息行硬删 ⇒ 进回收队列、没人用了', async () => {
    const group = await newGroup(owner, [member])
    const { sent, blob, key } = await whisper(owner, group, [member], `gc-${randomUUID()}`)
    await asOwner()
    await database.query('DELETE FROM chat.file_blob_uploads WHERE staging_key = $1', [key])
    const inUse = async () => (await database.query<{ u: boolean }>('SELECT chat.file_blob_in_use($1) AS u', [blob])).rows[0]!.u
    expect(await inUse()).toBe(true)
    // 撤回不放字节:行还在(发的人、收的人的记录里它还是那条撤回的消息),回收不动它。
    await database.query('UPDATE chat.messages SET retracted_at = now() WHERE id = $1', [sent.id])
    expect(await inUse()).toBe(true)
    await database.query('DELETE FROM chat.file_blob_gc WHERE blob_id = $1', [blob])
    await database.query('DELETE FROM chat.messages WHERE id = $1', [sent.id])
    expect(await inUse()).toBe(false)
    expect((await database.query('SELECT 1 FROM chat.file_blob_gc WHERE blob_id = $1', [blob])).rowCount).toBe(1)
  })

  it('形状与不变:不是悄悄话的不能指字节;发出后正文、指向都改不了', async () => {
    const group = await newGroup(owner, [member])
    const { sent, blob } = await whisper(owner, group, [member])
    await asOwner()
    // 来路对(登记到这条消息上),只是不是悄悄话 ⇒ CHECK 拒。
    const id = randomUUID()
    const up = await upload(owner, `shape-${randomUUID()}`, 'application/pdf', 4321)
    await database.query('UPDATE chat.file_blob_uploads SET message_id = $1 WHERE staging_key = $2', [id, up.key])
    expect(await fails(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, is_whisper, file_blob_id)
      VALUES ($1,$2,$3,$4,'attachment',false,$5)`, [id, group, owner, envelope('a.pdf', 'application/pdf', 4321), up.blob])).toMatch(/messages_file_blob_shape/)
    await asUser(owner)
    expect(await fails('UPDATE chat.messages SET content = $1 WHERE id = $2', ['edited', sent.id])).toMatch(/hint: message_file_fixed/)
    await asServiceRole()
    expect(await fails('UPDATE chat.messages SET file_blob_id = $1 WHERE id = $2', [up.blob, sent.id])).toMatch(/hint: message_file_fixed/)
    await asOwner()
    expect((await database.query<{ b: string }>('SELECT file_blob_id AS b FROM chat.messages WHERE id = $1', [sent.id])).rows[0]!.b).toBe(blob)
  })

  it('agent 收件(pull_agent_inbox_v2)拿到指针:file_blob_id / file_item_id / file_version(没有发布者那一列)', async () => {
    const group = await chatOf('group', [owner, member, agent])
    const { sent, blob } = await whisper(member, group, [agent])
    await asUser(owner)
    const { rows } = await database.query<Record<string, unknown>>('SELECT * FROM identity.pull_agent_inbox_v2($1)', [agent])
    await asOwner()
    const row = rows.find((r) => r.id === sent.id)
    expect(row).toMatchObject({ file_blob_id: blob, file_item_id: null, file_version: null })
    expect(row).not.toHaveProperty('file_publisher_user_id')
  })
})

// owner 10-17:发布者 = 消息的发送者。库里不另记、不推算 —— 这一列、算它的触发器和函数都没有了(视图、发消息、提交 / 转发回的行也没有)。
describe('发布者就是发送者:库里没有另记的那一列', () => {
  it('chat.messages、messages_view 没有 file_publisher_user_id;算它的函数没了;提交、转发回的行里也没有', async () => {
    await asOwner()
    const { rows: columns } = await database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'chat' AND table_name IN ('messages', 'messages_view') AND column_name = 'file_publisher_user_id'`)
    expect(columns).toEqual([])
    const { rows: gone } = await database.query<{ f: string | null }>(
      `SELECT to_regprocedure(f) AS f FROM unnest(ARRAY['chat.set_message_file_publisher()', 'chat.legacy_card_publisher(text,text,text,text,integer)',
        'chat.chat_media_uploader(text,text)']) AS f`)
    expect(gone).toEqual([{ f: null }, { f: null }, { f: null }])
    // 对照:同一个查法认得出还在的那一列。
    expect((await database.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'chat' AND table_name = 'messages_view' AND column_name = 'file_blob_id'`)).rowCount).toBe(1)
    const group = await newGroup(owner, [member])
    const other = await newGroup(member, [outsider])
    const sent = await send(owner, group, `pkg-${randomUUID()}`)
    const moved = await forward(member, sent.id, other)
    expect(sent).not.toHaveProperty('file_publisher_user_id')
    expect([sent.sender_user_id, moved.sender_user_id]).toEqual([owner, member])
  })
})
