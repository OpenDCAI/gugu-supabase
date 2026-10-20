import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * nmhjklnm/gugu#5919:删一个 agent,只清它自己那一面,❌ 删共享会话里的聊天记录。
 *
 * 场景:一个共享群(群主 + 路人 + agent)里有群主 @ 它的话、它自己说的话、路人的普通发言、
 * 路人回复它的话;外加群主与它的专属单聊。旧实现按「它发过 / 发给它」跨所有会话删消息,
 * 连带删掉这些消息上别人的表态,并把路人那条回复的 reply_to 置空。
 *
 * 判据取自 identity.erase_human_account:消息留着,只擦 to_user_ids / deleted_for_user_ids 里
 * 对这个身份的引用。专属单聊照旧清掉 —— 那一格是阳控,「函数什么都不做」也能让保留那几格全绿。
 *
 * 跑法:loopback `GUGU_INTEGRATION_DATABASE_URL`(跑过全部迁移的库);每条用例 BEGIN…ROLLBACK。
 */

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
  process.env.GUGU_INTEGRATION_DATABASE_URL
  ?? process.env.GUGU_DATABASE_URL
  ?? ''
).trim()

const OWNER = '59190000-0000-4000-8000-000000000001'
const BYSTANDER = '59190000-0000-4000-8000-000000000002'
const AGENT = 'agent-it-5919'
const DEVICE = 'dev-it-5919'
const GROUP = 'group-it-5919'
const DM = 'dm-it-5919'

let database: DatabaseClient

function requireLoopbackDatabase(): void {
  let parsed: URL
  try {
    parsed = new URL(DATABASE_URL)
  } catch {
    throw new Error('GUGU_INTEGRATION_DATABASE_URL is required')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`agentRemovalKeepsMessages5919.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`agentRemovalKeepsMessages5919.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
}

beforeAll(async () => {
  requireLoopbackDatabase()
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})

afterAll(async () => {
  await database?.end()
})

async function inRollback(body: () => Promise<void>): Promise<void> {
  await database.query('BEGIN')
  try {
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

async function seed(): Promise<void> {
  await database.query(
    `INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','owner'),($2,'human','bystander')`,
    [OWNER, BYSTANDER],
  )
  await database.query(
    `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform)
     VALUES ($1, $2, 'it-5919', 'it-5919', 'darwin')`,
    [DEVICE, OWNER],
  )
  await database.query(
    `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id) VALUES ($1,'agent','agent',$2,$3)`,
    [AGENT, OWNER, DEVICE],
  )
  await database.query(
    `INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','shared',$3),($2,'dm',NULL,$3)`,
    [GROUP, DM, OWNER],
  )
  await database.query(
    `INSERT INTO chat.chat_members (chat_id, user_id, role)
     VALUES ($1,$3,'owner'),($1,$4,'member'),($1,$5,'member'),($2,$3,'owner'),($2,$5,'member')`,
    [GROUP, DM, OWNER, BYSTANDER, AGENT],
  )
  const messages: Array<[string, string, string, string[] | null, string | null, string[]]> = [
    ['m1', GROUP, OWNER, [AGENT], null, []],
    ['m2', GROUP, AGENT, [OWNER], null, [BYSTANDER]],
    ['m3', GROUP, BYSTANDER, null, null, [AGENT]],
    ['m4', GROUP, BYSTANDER, null, 'm2', []],
    ['m5', DM, OWNER, [AGENT], null, []],
  ]
  for (const [id, chatId, sender, to, replyTo, deletedFor] of messages) {
    await database.query(
      `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids,
                                  reply_to_message_id, deleted_for_user_ids)
       VALUES ($1,$2,$3,$1,'text',$4,$5,$6::jsonb)`,
      [`${id}-it-5919`, chatId, sender, to, replyTo && `${replyTo}-it-5919`, JSON.stringify(deletedFor)],
    )
  }
  await database.query(
    `INSERT INTO chat.message_reactions (message_id, user_id, emoji)
     VALUES ('m3-it-5919',$1,'+1'),('m3-it-5919',$2,'tada'),('m2-it-5919',$3,'heart')`,
    [AGENT, BYSTANDER, OWNER],
  )
  await database.query(
    `INSERT INTO chat.message_deliveries (message_id, device_id, status)
     VALUES ('m3-it-5919',$1,'delivered'),('m2-it-5919',$2,'delivered')
     ON CONFLICT (message_id, device_id) DO NOTHING`,
    [`gugu-agent:${AGENT}`, DEVICE],
  )
}

async function removeAgentAsOwner(): Promise<void> {
  await database.query(
    "SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)",
    [OWNER],
  )
  await database.query('SET LOCAL role authenticated')
  await database.query('SELECT identity.remove_owned_agent($1)', [AGENT])
  await database.query('RESET role')
}

describe('#5919 removing an agent keeps the shared conversation', () => {
  it('keeps every shared-chat message, scrubs references to the agent, and still clears its exclusive DM', async () => {
    await inRollback(async () => {
      await seed()
      await removeAgentAsOwner()

      const identity = await database.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM identity.users WHERE id = $1', [AGENT])
      expect(identity.rows[0].n).toBe('0')

      const group = await database.query<{
        id: string
        sender_user_id: string | null
        to_user_ids: string[] | null
        reply_to_message_id: string | null
        deleted_for_user_ids: string[]
      }>(
        `SELECT id, sender_user_id, to_user_ids, reply_to_message_id, deleted_for_user_ids
         FROM chat.messages WHERE chat_id = $1 ORDER BY id`, [GROUP])
      expect(group.rows).toEqual([
        // 只 @ 它一个人:擦成空就成了「没点名」,会被 active agent 捡走 —— 保留它的 id(#6400)。
        { id: 'm1-it-5919', sender_user_id: OWNER, to_user_ids: [AGENT], reply_to_message_id: null, deleted_for_user_ids: [] },
        // 它自己的话留着;sender 的外键是 ON DELETE SET NULL,发送者归属随身份一起没了(既有缺口)。
        { id: 'm2-it-5919', sender_user_id: null, to_user_ids: [OWNER], reply_to_message_id: null, deleted_for_user_ids: [BYSTANDER] },
        { id: 'm3-it-5919', sender_user_id: BYSTANDER, to_user_ids: null, reply_to_message_id: null, deleted_for_user_ids: [] },
        { id: 'm4-it-5919', sender_user_id: BYSTANDER, to_user_ids: null, reply_to_message_id: 'm2-it-5919', deleted_for_user_ids: [] },
      ])

      // 阳控:它的专属单聊照旧清掉。
      const dm = await database.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM chat.messages WHERE chat_id = $1', [DM])
      expect(dm.rows[0].n).toBe('0')

      const reactions = await database.query<{ message_id: string; user_id: string }>(
        `SELECT message_id, user_id FROM chat.message_reactions
         WHERE message_id IN ('m2-it-5919','m3-it-5919') ORDER BY message_id, user_id`)
      expect(reactions.rows).toEqual([
        { message_id: 'm2-it-5919', user_id: OWNER },
        { message_id: 'm3-it-5919', user_id: BYSTANDER },
      ])

      const deliveries = await database.query<{ message_id: string; device_id: string }>(
        `SELECT message_id, device_id FROM chat.message_deliveries
         WHERE message_id IN ('m2-it-5919','m3-it-5919') ORDER BY message_id`)
      expect(deliveries.rows).toEqual([{ message_id: 'm2-it-5919', device_id: DEVICE }])
    })
  })
})
