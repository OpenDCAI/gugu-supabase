// 会话列表的预览:附件显示文件名,其它截 100 字 —— 对着**真库**跑的判官。
//
// 预览只在库里算一处(chat.message_preview):chats.last_message_preview 的两个写方与 messages_view 的计算列 preview
// 共用它。客户端直接显示,不再解析截断的附件信封。每条否定断言配正对照(文本照旧截 100、用户打的「[附件] …」原样)。
//
// 与 groupMemberJoinNotice6386 同形:loopback PostgreSQL、`GUGU_INTEGRATION_DATABASE_URL`,每条用例 BEGIN…ROLLBACK。
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface QueryResult<Row> { rows: Row[] }
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>
}

const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
const DATABASE_URL = (
  process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? ''
).trim()

let database: DatabaseClient

function requireLoopbackDatabase(): void {
  let parsed: URL
  try {
    parsed = new URL(DATABASE_URL)
  } catch {
    throw new Error('GUGU_INTEGRATION_DATABASE_URL is required')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`listPreviewAttachmentFileName.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`listPreviewAttachmentFileName.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
}

beforeAll(async () => {
  requireLoopbackDatabase()
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})
afterAll(async () => { await database?.end() })

async function inRollback(body: () => Promise<void>): Promise<void> {
  await database.query('BEGIN')
  try {
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

const OWNER = 'a11ce000-0000-4000-8000-000000000001'
const PEER = 'a11ce000-0000-4000-8000-000000000002'
const CHAT = 'preview-it-chat'

/**
 * 与客户端 formatAttachmentMetadata 同形的四行信封;URL 足够长,让「截 100 字」一定截在它中间。
 * 用非 Storage 的 URL:预览只看头行,Storage 的 URL 要另带规范的 bucket / object 引用(validate_storage_reference_pair),与本判据无关。
 */
function envelope(fileName: string, mimeType: string): string {
  return [
    `[附件] ${fileName}${mimeType ? ` (${mimeType})` : ''}`,
    `[URL] https://files.example.test/chat-media/${'0'.repeat(72)}/${fileName}`,
    '[Size] 12350',
    '[Kind] file',
  ].join('\n')
}

async function seed(): Promise<void> {
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','群主'),($2,'human','Sally')`, [OWNER, PEER])
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','预览',$2)`, [CHAT, OWNER])
  await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'owner'),($1,$3,'member')`, [CHAT, OWNER, PEER])
}

let seq = 0
async function post(content: string, contentType: 'text' | 'attachment', whisper = false): Promise<string> {
  seq += 1
  const id = `preview-it-${seq}`
  await database.query(
    `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, is_whisper)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, CHAT, OWNER, content, contentType, whisper ? [PEER] : null, whisper],
  )
  return id
}

async function chatPreview(): Promise<string | null> {
  const { rows } = await database.query<{ p: string | null }>('SELECT last_message_preview AS p FROM chat.chats WHERE id = $1', [CHAT])
  return rows[0]!.p
}

async function viewPreview(messageId: string): Promise<string | null> {
  const { rows } = await database.query<{ p: string | null }>('SELECT chat.preview(v) AS p FROM chat.messages_view v WHERE v.id = $1', [messageId])
  return rows[0]!.p
}

describe('会话列表的预览(对着真库跑)', () => {
  it('附件:会话行与 messages_view 的计算列都是文件名,不带任何标签、不露 URL', () => inRollback(async () => {
    await seed()
    const id = await post(envelope('季度 报告 (v2).pdf', 'application/pdf'), 'attachment')
    expect(await chatPreview()).toBe('季度 报告 (v2).pdf')
    expect(await viewPreview(id)).toBe('季度 报告 (v2).pdf')
    const noMime = await post(envelope('无类型', ''), 'attachment')
    expect(await viewPreview(noMime)).toBe('无类型')
  }))

  it('正对照:文本照旧截 100 字;用户自己打的「[附件] …」是 text,原样', () => inRollback(async () => {
    await seed()
    const long = await post('字'.repeat(150), 'text')
    expect(await chatPreview()).toBe('字'.repeat(100))
    expect(await viewPreview(long)).toBe('字'.repeat(100))
    const typed = await post('[附件] 我等下发你', 'text')
    expect(await chatPreview()).toBe('[附件] 我等下发你')
    expect(await viewPreview(typed)).toBe('[附件] 我等下发你')
  }))

  it('删掉最后一条:重算出的预览同样是文件名;悄悄话不进共享预览', () => inRollback(async () => {
    await seed()
    await post(envelope('plan.pdf', 'application/pdf'), 'attachment')
    const last = await post('这条会被删掉', 'text')
    expect(await chatPreview()).toBe('这条会被删掉')
    await database.query('UPDATE chat.messages SET deleted_at = now() WHERE id = $1', [last])
    expect(await chatPreview()).toBe('plan.pdf')
    await post(envelope('secret.png', 'image/png'), 'attachment', true)
    expect(await chatPreview()).toBe('plan.pdf')
  }))
})
