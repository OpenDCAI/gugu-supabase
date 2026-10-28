import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 车道 queued-status:宿主替 agent 落的「还在等它接走」系统行(turn-failure 的 notAdmitted / undelivered)不计未读、不当会话预览;
 * agent 的普通消息与配额这类真正的失败行照旧。每条用例 BEGIN…ROLLBACK,每条否定配正对照。
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

async function as<T = Row>(viewer: string, sql: string) {
  await db.query('SAVEPOINT viewer_role')
  try {
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: viewer, role: 'authenticated' })])
    await db.query('SET LOCAL ROLE authenticated')
    return (await db.query<T>(sql)).rows
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT viewer_role')
    await db.query('RELEASE SAVEPOINT viewer_role')
  }
}
async function fixture(body: (f: { owner: string; agent: string; chat: string }) => Promise<void>) {
  const [owner, agent, chat] = Array.from({ length: 3 }, () => randomUUID())
  await db.query('BEGIN')
  try {
    await db.query("INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human','owner')", [owner])
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES ($1,$2,'it','it','linux')", [`dev-${owner}`, owner])
    await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES ($1,'agent','agent',$2,$3)", [agent, owner, `dev-${owner}`])
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','pending delivery',$2)", [chat, owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')", [chat, owner, agent])
    await db.query('UPDATE chat.chat_members SET inbox_published_at = now(), last_read_seq = 0 WHERE chat_id = $1', [chat])
    await body({ owner, agent, chat })
  } finally { await db.query('ROLLBACK') }
}
async function say(chat: string, sender: string, content: string): Promise<void> {
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES ($1,$2,$3,$4,'text')", [randomUUID(), chat, sender, content])
}
/** The row the host writes for an agent: content for agents and old clients, the reason in client_message_id. */
async function failureRow(chat: string, agent: string, reason: string): Promise<void> {
  const id = `turn-failure:batch:${randomUUID()}`
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,client_message_id) VALUES ($1,$2,$3,$4,'system',$5)",
    [id, chat, agent, `row ${reason}`, `turn-failure:${id}:${reason}`])
}
async function unread(viewer: string): Promise<number> {
  const rows = await as<{ unread_count: string }>(viewer, "SELECT unread_count::text FROM chat.list_unread_locators(NULL) WHERE stream_kind = 'main'")
  return rows.reduce((sum, row) => sum + Number(row.unread_count), 0)
}
async function preview(viewer: string): Promise<unknown> {
  const [row] = await as<{ value: { previews: Row[] } }>(viewer, 'SELECT chat.sync_snapshot() AS value')
  return row!.value.previews[0]!.preview
}

describe('a row saying the host still holds messages for the agent is neither unread nor the preview', () => {
  it('notAdmitted and undelivered rows add no unread and leave the preview on the last real message', async () => fixture(async (f) => {
    await say(f.chat, f.owner, 'please look at this')
    await failureRow(f.chat, f.agent, 'notAdmitted')
    await failureRow(f.chat, f.agent, 'undelivered')
    expect(await unread(f.owner)).toBe(0)
    expect(await preview(f.owner)).toBe('please look at this')
  }))

  it('the agent’s ordinary reply and a real failure row still count and still preview', async () => fixture(async (f) => {
    await say(f.chat, f.owner, 'please look at this')
    await failureRow(f.chat, f.agent, 'notAdmitted')
    await say(f.chat, f.agent, 'on it')
    expect(await unread(f.owner)).toBe(1)
    expect(await preview(f.owner)).toBe('on it')
    await failureRow(f.chat, f.agent, 'weeklyQuota')
    expect(await unread(f.owner)).toBe(2)
    expect(await preview(f.owner)).toBe('row weeklyQuota')
  }))

  it('only the marker naming this very row counts: a copied marker on another row is an ordinary row', async () => fixture(async (f) => {
    const id = randomUUID()
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,client_message_id) VALUES ($1,$2,$3,'forged','system','turn-failure:someone-else:notAdmitted')",
      [id, f.chat, f.agent])
    expect(await unread(f.owner)).toBe(1)
    expect(await preview(f.owner)).toBe('forged')
  }))

  it('keeps both readers STABLE', async () => {
    const rows = (await db.query<{ provolatile: string }>("SELECT provolatile FROM pg_proc WHERE oid IN ('chat.list_unread_locators(text)'::regprocedure, 'chat.sync_snapshot()'::regprocedure)")).rows
    expect(rows.map((row) => row.provolatile)).toEqual(['s', 's'])
  })
})
