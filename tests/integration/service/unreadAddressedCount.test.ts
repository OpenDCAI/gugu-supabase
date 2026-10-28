import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * list_unread_locators.addressed_count:未读里叫到你的那几条 —— 点名你、@all、或回复你说过的那条。
 * agent 开的话题会把主人拉成成员,agent 之间的往来照旧算话题的未读,但不算叫到主人。每条用例 BEGIN…ROLLBACK,每条否定配正对照。
 */
type Row = Record<string, unknown>
interface Db {
  connect(): Promise<void>
  end(): Promise<void>
  query<T = Row>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as { Client: new (options: { connectionString: string }) => Db }
const connectionString = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
let db: Db
beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('requires disposable loopback PostgreSQL')
  db = new Client({ connectionString })
  await db.connect()
})
afterAll(async () => { await db?.end() })

async function as<T = Row>(viewer: string, sql: string, values: unknown[] = []) {
  await db.query('SAVEPOINT viewer_role')
  try {
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: viewer, role: 'authenticated' })])
    await db.query('SET LOCAL ROLE authenticated')
    return (await db.query<T>(sql, values)).rows
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT viewer_role')
    await db.query('RELEASE SAVEPOINT viewer_role')
  }
}
type Fixture = { owner: string; a: string; b: string; group: string; topic: string }
async function fixture(body: (f: Fixture) => Promise<void>) {
  const [owner, a, b, group, topic, anchor] = Array.from({ length: 6 }, () => randomUUID())
  await db.query('BEGIN')
  try {
    await db.query("INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human','owner')", [owner])
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES ($1,$2,'it','it','linux')", [`dev-${owner}`, owner])
    for (const agent of [a, b]) {
      await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES ($1,'agent','agent',$2,$3)", [agent, owner, `dev-${owner}`])
    }
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','project',$2)", [group, owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')", [group, owner, a, b])
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'anchor')", [anchor, group, a])
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id,source_message_id) VALUES ($1,'topic','agents at work',$2,$3,$4)", [topic, a, group, anchor])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')", [topic, owner, a, b])
    await db.query('UPDATE chat.chat_members SET inbox_published_at = now(), last_read_seq = 0 WHERE chat_id IN ($1,$2)', [group, topic])
    // 锚点那条在群主线上,不是这里要数的;从它之后数。
    await db.query('UPDATE chat.chat_members SET last_read_seq = (SELECT max(seq) FROM chat.messages WHERE chat_id = $1) WHERE chat_id = $1', [group])
    await body({ owner, a, b, group, topic })
  } finally { await db.query('ROLLBACK') }
}
async function say(chat: string, sender: string, options: { to?: string[]; reply?: string; whisper?: boolean; root?: string; isRoot?: boolean } = {}): Promise<string> {
  const id = randomUUID()
  await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,to_user_ids,reply_to_message_id,is_whisper,thread_root_id,is_thread_root)
    VALUES ($1,$2,$3,'hello','text',$4,$5,$6,$7,$8)`,
    [id, chat, sender, options.to ?? null, options.reply ?? null, options.whisper ?? false, options.root ?? null, options.isRoot ?? false])
  return id
}
async function counts(viewer: string, chat: string, kind: 'main' | 'thread' = 'main') {
  const rows = await as<{ unread_count: string; addressed_count: string }>(viewer,
    'SELECT unread_count::text, addressed_count::text FROM chat.list_unread_locators(NULL) WHERE chat_id = $1 AND stream_kind = $2', [chat, kind])
  return rows.reduce((sum, row) => ({ unread: sum.unread + Number(row.unread_count), addressed: sum.addressed + Number(row.addressed_count) }), { unread: 0, addressed: 0 })
}

describe('list_unread_locators.addressed_count', () => {
  it('agent-to-agent topic traffic is unread for the enrolled owner but not addressed to them', () => fixture(async ({ owner, a, b, topic }) => {
    await say(topic, a, { to: [b] })
    await say(topic, b)
    expect(await counts(owner, topic)).toEqual({ unread: 2, addressed: 0 })
    await say(topic, a, { to: [owner] })
    expect(await counts(owner, topic)).toEqual({ unread: 3, addressed: 1 })
  }))

  it('@all, a whisper to you and a reply to what you said are addressed; a reply to someone else is not', () => fixture(async ({ owner, a, b, topic }) => {
    const mine = await say(topic, owner)
    const theirs = await say(topic, b)
    await say(topic, a, { reply: theirs })
    expect(await counts(owner, topic)).toEqual({ unread: 2, addressed: 0 })
    await say(topic, a, { reply: mine })
    await say(topic, b, { to: ['*'] })
    await say(topic, a, { to: [owner], whisper: true })
    expect(await counts(owner, topic)).toEqual({ unread: 5, addressed: 3 })
  }))

  it('thread replies are counted the same way on their own stream', () => fixture(async ({ owner, a, b, group }) => {
    const root = await say(group, a, { isRoot: true })
    await say(group, b, { root })
    expect(await counts(owner, group, 'thread')).toEqual({ unread: 1, addressed: 0 })
    await say(group, b, { root, to: [owner] })
    expect(await counts(owner, group, 'thread')).toEqual({ unread: 2, addressed: 1 })
  }))

  it('a manual unread mark counts as addressed, like it counts as unread', () => fixture(async ({ owner, a, topic }) => {
    await say(topic, a)
    await db.query('UPDATE chat.chat_members SET last_read_seq = (SELECT max(seq) FROM chat.messages WHERE chat_id = $1) WHERE chat_id = $1 AND user_id = $2', [topic, owner])
    expect(await counts(owner, topic)).toEqual({ unread: 0, addressed: 0 })
    await db.query('UPDATE chat.chat_members SET is_marked_unread = true WHERE chat_id = $1 AND user_id = $2', [topic, owner])
    expect(await counts(owner, topic)).toEqual({ unread: 1, addressed: 1 })
  }))

  it('the account snapshot carries the same addressed count', () => fixture(async ({ owner, a, b, topic }) => {
    await say(topic, a, { to: [b] })
    await say(topic, a, { to: [owner] })
    const [row] = await as<{ snapshot: { unread: Array<{ chat_id: string; unread_count: number; addressed_count: number }> } }>(owner, 'SELECT chat.sync_snapshot() AS snapshot')
    const unread = row.snapshot.unread.filter((entry) => entry.chat_id === topic)
    expect(unread.map(({ unread_count, addressed_count }) => ({ unread_count, addressed_count }))).toEqual([{ unread_count: 2, addressed_count: 1 }])
  }))
})
