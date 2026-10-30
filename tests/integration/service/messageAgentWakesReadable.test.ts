import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 车道 queued-status:chat.message_agent_wakes 对看得见那条消息的人可读,对看不见的人不可读 —— 判据是 chat.messages 自己的行策略。
 * 群:群主(真人,agent 的主人)、路人(真人)、一个 agent。每条否定配正对照;每条用例 BEGIN…ROLLBACK。
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
const DATABASE_URL = (process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '').trim()

const OWNER = '27100000-0000-4000-8000-000000000001'
const BYSTANDER = '27100000-0000-4000-8000-000000000002'
const OUTSIDER = '27100000-0000-4000-8000-000000000003'
const AGENT = 'agent-it-queued-1027'
const DEVICE = 'dev-it-queued-1027'
const GROUP = '27100000-0000-4000-8000-000000000004'

let database: DatabaseClient

beforeAll(async () => {
  const host = new URL(DATABASE_URL).hostname
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`requires loopback PostgreSQL, got ${host}`)
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})
afterAll(async () => { await database?.end() })

async function inRollback(body: () => Promise<void>): Promise<void> {
  await database.query('BEGIN')
  try { await body() } finally { await database.query('ROLLBACK') }
}

async function seed(): Promise<void> {
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','owner'),($2,'human','bystander'),($3,'human','outsider')`,
    [OWNER, BYSTANDER, OUTSIDER])
  await database.query(`INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ($1,$2,'it','it','darwin')`, [DEVICE, OWNER])
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id) VALUES ($1,'agent','agent',$2,$3)`, [AGENT, OWNER, DEVICE])
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','shared',$2)`, [GROUP, OWNER])
  await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode)
    VALUES ($1,$2,'owner','passive'),($1,$3,'member','passive'),($1,$4,'member','passive')`, [GROUP, OWNER, BYSTANDER, AGENT])
}

async function send(id: string, opts: { whisper?: boolean } = {}): Promise<void> {
  await database.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, is_whisper)
    VALUES ($1,$2,$3,$1,'text',$4,$5)`, [id, GROUP, OWNER, [AGENT], opts.whisper ?? false])
}

/** The wake rows `viewer` can read for these messages, through the Data API role. */
async function wakesSeenBy(viewer: string, ids: string[]): Promise<string[]> {
  await database.query("SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)", [viewer])
  await database.query('SET LOCAL role authenticated')
  const { rows } = await database.query<{ message_id: string; agent_user_id: string }>(
    'SELECT message_id, agent_user_id FROM chat.message_agent_wakes WHERE message_id = ANY($1) ORDER BY message_id', [ids])
  await database.query('RESET role')
  return rows.map((row) => `${row.message_id}>${row.agent_user_id}`)
}

describe('who a message wakes is readable exactly by those who can read the message', () => {
  it('a member reads the wake row of a message to the agent; someone outside the group does not', async () => {
    await inRollback(async () => {
      await seed()
      await send('open-1027')
      expect(await wakesSeenBy(OWNER, ['open-1027'])).toEqual([`open-1027>${AGENT}`])
      expect(await wakesSeenBy(BYSTANDER, ['open-1027'])).toEqual([`open-1027>${AGENT}`])
      expect(await wakesSeenBy(OUTSIDER, ['open-1027'])).toEqual([])
    })
  })

  it('a whisper’s wake row is not readable by a third member, while its sender reads it', async () => {
    await inRollback(async () => {
      await seed()
      await send('whisper-1027', { whisper: true })
      expect(await wakesSeenBy(OWNER, ['whisper-1027'])).toEqual([`whisper-1027>${AGENT}`])
      expect(await wakesSeenBy(BYSTANDER, ['whisper-1027'])).toEqual([])
    })
  })

  it('stays read-only for clients', async () => {
    await inRollback(async () => {
      await seed()
      await send('open-1027')
      await database.query("SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)", [OWNER])
      await database.query('SET LOCAL role authenticated')
      await expect(database.query('INSERT INTO chat.message_agent_wakes (message_id, agent_user_id) VALUES ($1,$2)', ['open-1027', OWNER]))
        .rejects.toThrow(/permission denied/)
    })
  })
})
