// @@@6854 服务端写的两种系统行,标记的形状由这里钉住 —— 客户端(gugu 的 packages/core/src/shared/ui/disclosureNotice.ts)
// 靠它按**读者**的语言说这两行,content 只剩回落:
//   · 「X 开了话题」:client_message_id = 'topic-opened:<话题 chat id>',发信人是开话题的 agent(客户端再核话题 creator = 发信人)
//   · 「agent 较多,已转为被动模式」:client_message_id = 'agent-flood:<本行 id>',无发信人
// 谁改 create_topic / apply_agent_flood_rule 把这两个形状改了,这里先红 —— 否则客户端悄悄退回画写入方的原文。
//
// loopback PostgreSQL、`GUGU_INTEGRATION_DATABASE_URL`,与 topicAccessControl5856 / agentFloodThreshold5856 同形。
// 每条用例自己 BEGIN…ROLLBACK,库里零残留;否定断言配正对照。
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
    throw new Error(`systemNoticeMarkers6854.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`systemNoticeMarkers6854.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
}

function uid(tag: string, n: number): string {
  const head = tag.padEnd(8, '0').slice(0, 8).replace(/[^0-9a-f]/g, '0')
  return `${head}-aaaa-4000-8000-${String(n).padStart(12, '0')}`
}

async function asUser(userId: string): Promise<void> {
  await database.query('SET LOCAL role TO authenticated')
  await database.query(`SET LOCAL request.jwt.claims TO '{"sub":"${userId}","role":"authenticated"}'`)
}
async function asService(): Promise<void> {
  await database.query('RESET role')
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

interface Room { owner: string; group: string; sourceMessage: string; agents: string[] }

/** 一个群(群主 + 一条源消息)和 7 个群主名下、还没入群的 agent。 */
async function seedRoom(tag: string): Promise<Room> {
  const owner = uid(tag, 1)
  const group = uid(tag, 11)
  const sourceMessage = uid(tag, 21)
  const device = `dev-notice-${tag}`
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','群主')`, [owner])
  await database.query(
    `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ($1, $2, 'n', 'n', 'darwin')`,
    [device, owner],
  )
  const agents: string[] = []
  for (let index = 0; index < 7; index += 1) {
    const agent = uid(tag, 100 + index)
    agents.push(agent)
    await database.query(
      `INSERT INTO identity.users (id, type, display_name, device_id, owner_user_id) VALUES ($1,'agent',$2,$3,$4)`,
      [agent, `A${index + 1}`, device, owner],
    )
  }
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','群',$2)`, [group, owner])
  await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'owner')`, [group, owner])
  await database.query(
    `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type) VALUES ($1,$2,$3,1,'做个看板','text')`,
    [sourceMessage, group, owner],
  )
  return { owner, group, sourceMessage, agents }
}

async function joinAgents(chatId: string, agents: string[]): Promise<void> {
  for (const agent of agents) {
    await database.query(
      `INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode) VALUES ($1,$2,'member','active')`,
      [chatId, agent],
    )
  }
}

type SystemRow = { id: string; sender_user_id: string | null; client_message_id: string | null }
async function systemRows(chatId: string, marker: string): Promise<SystemRow[]> {
  const { rows } = await database.query<SystemRow>(
    `SELECT id, sender_user_id, client_message_id FROM chat.messages
     WHERE chat_id = $1 AND content_type = 'system' AND client_message_id LIKE $2 ORDER BY created_at`,
    [chatId, `${marker}%`],
  )
  return rows
}

describe('#6854 服务端系统行的标记形状', () => {
  it('agent 开话题:来源线里落一行,client_message_id 是 topic-opened:<话题 chat id>,发信人是那个 agent', async () => {
    await inRollback(async () => {
      const room = await seedRoom('6854a')
      const agent = room.agents[0]!
      await joinAgents(room.group, [agent])
      await asUser(room.owner)
      const { rows } = await database.query<{ chat_id: string }>(
        'SELECT chat_id FROM chat.create_topic($1,$2,$3,NULL,$4)',
        [room.group, room.sourceMessage, '看板', agent],
      )
      await asService()
      const topicChatId = rows[0]!.chat_id
      expect(await systemRows(room.group, 'topic-opened:')).toEqual([
        expect.objectContaining({ sender_user_id: agent, client_message_id: `topic-opened:${topicChatId}` }),
      ])
    })
  })

  it('正对照:人自己开话题不落这一行(只有 agent 开的才说)', async () => {
    await inRollback(async () => {
      const room = await seedRoom('6854b')
      await asUser(room.owner)
      const { rows } = await database.query<{ chat_id: string }>(
        'SELECT chat_id FROM chat.create_topic($1,$2,$3,NULL,NULL)',
        [room.group, room.sourceMessage, '看板'],
      )
      await asService()
      expect(rows).toHaveLength(1)
      expect(await systemRows(room.group, 'topic-opened:')).toEqual([])
    })
  })

  it('agent 较多转被动:client_message_id 就是 agent-flood:<本行 id>,无发信人', async () => {
    await inRollback(async () => {
      const room = await seedRoom('6854c')
      // 产品默认上限 5:第 6 个 agent 进群才落这一行(判据见 agentFloodThreshold5856)。
      await joinAgents(room.group, room.agents.slice(0, 6))
      const flood = await systemRows(room.group, 'agent-flood:')
      expect(flood).toHaveLength(1)
      expect(flood[0]).toMatchObject({ sender_user_id: null, client_message_id: `agent-flood:${flood[0]!.id}` })
    })
  })
})
