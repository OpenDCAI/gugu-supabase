import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 老式卡片(字节在公开的 chat-media 桶里)也按消息签字节(gugu#7290):attachments/urls 的 {message_id} 收老式卡片,链接按 storage 列指的
 * 对象签;正文里客户端写的 [URL] 不参与。发布者就是消息的发送者(迁移 *_attachment_publisher_is_sender),库里不另算。
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
let alice: string
let mallory: string
let reader: string
let outsider: string

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asOwner() {
  await database.query('RESET role')
}
async function human(name: string): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@legacy-card-urls.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  return id
}
async function group(members: string[]): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group',NULL,$2)`, [id, members[0]])
  for (const [i, user] of members.entries()) {
    await database.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,$3)`, [id, user, i === 0 ? 'owner' : 'member'])
  }
  return id
}
/** An object in chat-media, under `by`, as the bucket lets one upload it. */
async function uploaded(by: string, name = 'tool.guguext'): Promise<string> {
  await asOwner()
  const object = `${by}/${randomUUID()}-${name}`
  await database.query(`INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('chat-media',$1,'{"size":409,"mimetype":"application/vnd.gugu.extension+zip"}')`, [object])
  return object
}
const HOST = 'db.legacy-card.test'
const publicUrl = (object: string) => `https://${HOST}/storage/v1/object/public/chat-media/${object}`
const card = (object: string, name = 'tool.guguext') =>
  `[附件] ${name} (application/vnd.gugu.extension+zip)\n[URL] ${publicUrl(object)}\n[Size] 409\n[Kind] file`
type Row = { id: string }
/** An old client's card: the message names its object in the storage columns; the text names whatever it wrote. */
async function oldCard(sender: string, chatId: string, storageObject: string | null, textObject = storageObject ?? 'x', extra: { to?: string[]; whisper?: boolean; forwardedFrom?: string; name?: string } = {}): Promise<Row> {
  await asUser(sender)
  const { rows } = await database.query<Row>(
    `INSERT INTO chat.messages (id, chat_id, sender_user_id, to_user_ids, content, content_type, is_whisper, storage_bucket_id, storage_object_name, forwarded_from_message_id)
     VALUES ($1,$2,$3,$4,$5,'attachment',$6,$7,$8,$9) RETURNING id`,
    [randomUUID(), chatId, sender, extra.to ?? [], card(textObject, extra.name), extra.whisper ?? false, storageObject ? 'chat-media' : null, storageObject, extra.forwardedFrom ?? null])
  await asOwner()
  return rows[0]!
}
type Url = { message_id: string; bucket_id: string; object_name: string; file_name: string; size_bytes: string; content_type: string }
async function urls(as: string, messageId: string): Promise<Url[]> {
  await asUser(as)
  const { rows } = await database.query<Url>('SELECT * FROM chat.file_urls_as($1::jsonb, $2)', [JSON.stringify([{ message_id: messageId }]), as])
  await asOwner()
  return rows
}
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('legacyCardUrls.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  alice = await human('Alice')
  mallory = await human('Mallory')
  reader = await human('Reader')
  outsider = await human('Outsider')
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

describe('attachments/urls 按消息也签老式卡片', () => {
  it('读得到的人:按 storage 列的对象,带名字、对象的大小与类型;不在会话里的、悄悄话的第三人、撤回以后:没有这一行', async () => {
    const chat = await group([alice, reader, mallory])
    // 对象名只能是 [A-Za-z0-9._~-](messages_storage_reference_chk);显示的名字在正文里。
    const object = await uploaded(alice, 'vote.guguext')
    const sent = await oldCard(alice, chat, object, object, { name: '投票.guguext' })
    expect(await urls(reader, sent.id)).toEqual([expect.objectContaining({
      message_id: sent.id, bucket_id: 'chat-media', object_name: object, file_name: '投票.guguext',
      size_bytes: '409', content_type: 'application/vnd.gugu.extension+zip',
    })])
    expect(await urls(outsider, sent.id)).toEqual([])
    const whisper = await oldCard(alice, chat, await uploaded(alice), undefined, { to: [reader], whisper: true })
    expect((await urls(reader, whisper.id)).length).toBe(1)
    expect(await urls(mallory, whisper.id)).toEqual([])
    await asOwner()
    await database.query('UPDATE chat.messages SET retracted_at = now() WHERE id = $1', [sent.id])
    expect(await urls(reader, sent.id)).toEqual([])
  })
})

// 老式卡片被转发时也走新链(owner 10-18):字节由边缘函数从 chat-media 读出来、登记成一次上传(这里直接登记,和
// attachments/forward 做的那一步一样),attachment_forward 带上它 ⇒ 目标会话的「附件」里一个条目,不再有指向 chat-media 的新消息。
describe('转发老式卡片走新链', () => {
  const FORWARD = 'SELECT * FROM chat.attachment_forward($1,$2,$3,$4,$5,NULL,false,false,$6)'
  const ZIP = 'application/vnd.gugu.extension+zip'
  async function registered(by: string, content: string, type = ZIP): Promise<string> {
    const key = `staging/${by}/${randomUUID()}`
    await database.query('SET LOCAL role service_role')
    await database.query('SELECT * FROM chat.file_blob_register($1,$2,$3,409,$4,NULL,NULL)', [by, key, createHash('sha256').update(content).digest('hex'), type])
    await asOwner()
    return key
  }
  type Sent = { id: string; chat_id: string; content: string; file_item_id: string | null; storage_object_name: string | null; forwarded_from_message_id: string | null }
  async function sent(id: string): Promise<Sent | undefined> {
    await asOwner()
    return (await database.query<Sent>('SELECT id, chat_id, content, file_item_id, storage_object_name, forwarded_from_message_id FROM chat.messages WHERE id = $1', [id])).rows[0]
  }
  async function fails(sql: string, values: unknown[]): Promise<string> {
    await database.query('SAVEPOINT expected_failure')
    try { await database.query(sql, values) } catch (error) {
      await database.query('ROLLBACK TO SAVEPOINT expected_failure')
      const e = error as Error & { hint?: string }
      return `${e.message} | hint: ${e.hint ?? ''}`
    }
    await database.query('RELEASE SAVEPOINT expected_failure')
    return 'did not fail'
  }

  it('读得到的人:库说出对象名、文件名、类型;读不到的人、撤回以后:没有这一行', async () => {
    const source = await group([alice, reader])
    const object = await uploaded(alice, 'tool.guguext')
    const card1 = await oldCard(alice, source, object)
    await asUser(reader)
    expect((await database.query('SELECT * FROM chat.attachment_legacy_source($1)', [card1.id])).rows).toEqual([{ object_name: object, file_name: 'tool.guguext', content_type: ZIP }])
    await asUser(outsider)
    expect((await database.query('SELECT * FROM chat.attachment_legacy_source($1)', [card1.id])).rows).toEqual([])
    await asOwner()
    await database.query('UPDATE chat.messages SET retracted_at = now() WHERE id = $1', [card1.id])
    await asUser(reader)
    expect((await database.query('SELECT * FROM chat.attachment_legacy_source($1)', [card1.id])).rows).toEqual([])
    await asOwner()
  })

  it('带上登记好的上传转:目标会话的「附件」里一个条目,新信封(无 [URL]),说明照抄,记转自哪一条;重试回同一条;不带上传、新式带上传都拒', async () => {
    const source = await group([alice, reader])
    const target = await group([reader, outsider])
    const object = await uploaded(alice, 'tool.guguext')
    const original = await oldCard(alice, source, object)
    await asOwner()
    await database.query(`UPDATE chat.messages SET content = content || E'\n[Caption]\n看这个' WHERE id = $1`, [original.id])
    const key = await registered(reader, `legacy-${randomUUID()}`)
    const id = randomUUID()
    await asUser(reader)
    await database.query(FORWARD, [original.id, id, target, reader, '{}', key])
    const moved = await sent(id)
    expect(moved).toMatchObject({ chat_id: target, forwarded_from_message_id: original.id, storage_object_name: null, file_item_id: expect.any(String) })
    expect(moved!.content).toBe(`[附件] tool.guguext (${ZIP})\n[Size] 409\n[Kind] file\n[Caption]\n看这个`)
    // 重试同一条:同一份上传、同一个消息 id ⇒ 同一条,目标会话里只有一条。
    await asUser(reader)
    await database.query(FORWARD, [original.id, id, target, reader, '{}', key])
    await asOwner()
    expect(Number((await database.query<{ n: string }>('SELECT count(*) AS n FROM chat.messages WHERE chat_id = $1', [target])).rows[0]!.n)).toBe(1)

    await asUser(reader)
    expect(await fails(FORWARD, [original.id, randomUUID(), target, reader, '{}', null])).toMatch(/hint: attachment_forward_needs_bytes/)
    // 新式的原消息:带上传就拒(它由库自己转,不收字节)。
    await asOwner()
    const newKey = await registered(alice, `new-${randomUUID()}`)
    await asUser(alice)
    const fresh = randomUUID()
    await database.query('SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5)', [newKey, fresh, source, alice, 'new.guguext'])
    const another = await registered(reader, `again-${randomUUID()}`)
    await asUser(reader)
    expect(await fails(FORWARD, [fresh, randomUUID(), target, reader, '{}', another])).toMatch(/hint: file_place_invalid/)
    await asOwner()
  })

  it('老式语音(三行正文,没有说明):时长和转写那两行原样当说明带过去', async () => {
    const source = await group([alice, reader])
    const target = await group([reader, outsider])
    const object = await uploaded(alice, 'voice.m4a')
    const id = randomUUID()
    await asUser(alice)
    await database.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, storage_bucket_id, storage_object_name)
      VALUES ($1,$2,$3,$4,'attachment','chat-media',$5)`, [id, source, alice, '[附件] voice.m4a (audio/mp4)\n[语音] durationMs=1500\n[转写] 你好呀', object])
    await asOwner()
    const key = await registered(reader, `voice-${randomUUID()}`, 'audio/mp4')
    const moved = randomUUID()
    await asUser(reader)
    await database.query(FORWARD, [id, moved, target, reader, '{}', key])
    expect((await sent(moved))!.content).toBe('[附件] voice.m4a (audio/mp4)\n[Size] 409\n[Kind] file\n[Caption]\n[语音] durationMs=1500\n[转写] 你好呀')
  })
})
