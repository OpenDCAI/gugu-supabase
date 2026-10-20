// 20261001062800 —— chat.can_see_topic_message 换了 AND 两边的顺序(先判「是话题、人在来源线里」,再判提问的人
// 有没有资格问)。这一份判官钉住「谁看得见话题里的消息」一点没变:话题成员、只在来源线里的人、局外人各一格,
// 再加函数本身对局外人照旧不开口。快慢不在这里断言(❌ 墙钟);改前改后的耗时在迁移注释和 PR 里。
//
// 与 topicAccessControl5856 同形:loopback PostgreSQL、`GUGU_INTEGRATION_DATABASE_URL`,每条用例 BEGIN…ROLLBACK,
// 每条否定断言配一个正对照。
// 跑法:`GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:34890/postgres \
//        pnpm exec vitest run topicMessageCheckTopicFirst`
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

beforeAll(async () => {
  const parsed = new URL(DATABASE_URL)
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`topicMessageCheckTopicFirst.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})
afterAll(async () => { await database?.end() })

function uid(tag: string, n: number): string {
  const head = tag.padEnd(8, '0').slice(0, 8).replace(/[^0-9a-f]/g, '0')
  return `${head}-bbbb-4000-8000-${String(n).padStart(12, '0')}`
}
async function asUser(userId: string): Promise<void> {
  await database.query('SET LOCAL role TO authenticated')
  await database.query(`SET LOCAL request.jwt.claims TO '{"sub":"${userId}","role":"authenticated"}'`)
}
async function asService(): Promise<void> {
  await database.query('RESET role')
}
async function inRollback(body: () => Promise<void>): Promise<void> {
  await database.query('BEGIN')
  try {
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

interface World { owner: string; carol: string; stranger: string; group: string; topic: string; topicMessageAt: string }

/**
 * 群里有 owner 与 carol(都没有时间界)和一条消息;owner 从它开了话题,话题里有一条消息。
 * owner 是话题成员;carol 只在来源线里;stranger 哪条线都不在。
 */
async function seed(tag: string): Promise<World> {
  const owner = uid(tag, 1)
  const carol = uid(tag, 2)
  const stranger = uid(tag, 3)
  const group = uid(tag, 11)
  const sourceMessage = uid(tag, 21)
  await database.query(
    `INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','群主'),($2,'human','Carol'),($3,'human','路人')`,
    [owner, carol, stranger],
  )
  await database.query(
    `INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','来源线',$2)`,
    [group, owner],
  )
  await database.query(
    `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'owner'),($1,$3,'member')`,
    [group, owner, carol],
  )
  await database.query(
    `UPDATE chat.chat_members SET hide_history_before = NULL WHERE chat_id = $1 AND user_id IN ($2,$3)`,
    [group, owner, carol],
  )
  await database.query(
    `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type, created_at)
     VALUES ($1,$2,$3,1,'来源消息','text', now() - interval '2 hour')`,
    [sourceMessage, group, owner],
  )
  await asUser(owner)
  const { rows } = await database.query<{ chat_id: string }>(
    `SELECT chat_id FROM chat.create_topic($1,$2,$3,NULL,NULL)`, [group, sourceMessage, '话题'],
  )
  const topic = rows[0]!.chat_id
  await asService()
  const made = await database.query<{ created_at: string }>(
    `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type, created_at)
     VALUES ($1,$2,$3,1,'TOPIC-LINE','text', now() - interval '1 hour') RETURNING created_at`,
    [uid(tag, 31), topic, owner],
  )
  // 三种人的身份是这一份判官的前提:owner 在话题里,carol 不在话题里、在来源线里。
  const members = await database.query<{ user_id: string }>(
    `SELECT user_id FROM chat.chat_members WHERE chat_id = $1`, [topic],
  )
  expect(members.rows.map((r) => r.user_id)).toContain(owner)
  expect(members.rows.map((r) => r.user_id)).not.toContain(carol)
  return { owner, carol, stranger, group, topic, topicMessageAt: made.rows[0]!.created_at }
}

async function topicLineAs(world: World, userId: string): Promise<string[]> {
  await asUser(userId)
  const { rows } = await database.query<{ content: string }>(
    `SELECT content FROM chat.messages_view WHERE chat_id = $1 ORDER BY seq`, [world.topic],
  )
  await asService()
  return rows.map((r) => r.content)
}

describe('can_see_topic_message 先判话题、再判提问资格:谁看得见什么不变', () => {
  it('话题成员、只在来源线里的人读得到话题里的消息;局外人读不到', async () => {
    await inRollback(async () => {
      const world = await seed('d1')
      expect(await topicLineAs(world, world.owner)).toEqual(['TOPIC-LINE'])
      expect(await topicLineAs(world, world.carol)).toEqual(['TOPIC-LINE'])
      expect(await topicLineAs(world, world.stranger)).toEqual([])
    })
  })

  it('不带过滤的 limit 1(发版契约门的读法):局外人 0 行,只在来源线里的人照常有行', async () => {
    await inRollback(async () => {
      const world = await seed('d2')
      await asUser(world.stranger)
      const outsider = await database.query(`SELECT chat_id FROM chat.messages_view LIMIT 1`)
      expect(outsider.rows).toHaveLength(0)
      // 正对照:同一条读法,看得见消息的人有行 —— 「0 行」不是视图或 RLS 上下文坏了。
      await asUser(world.carol)
      const insider = await database.query(`SELECT chat_id FROM chat.messages_view LIMIT 1`)
      expect(insider.rows).toHaveLength(1)
    })
  })

  it('函数本身照旧只回答有资格问的人;非话题的线一律是否', async () => {
    await inRollback(async () => {
      const world = await seed('d3')
      const ask = async (asker: string, chatId: string, subject: string): Promise<boolean | undefined> => {
        await asUser(asker)
        const { rows } = await database.query<{ sees: boolean }>(
          `SELECT chat.can_see_topic_message($1,$2::timestamptz,$3) AS sees`, [chatId, world.topicMessageAt, subject],
        )
        await asService()
        return rows[0]?.sees
      }
      // 局外人拿 carol 当主体问:否(探针门还在)。
      expect(await ask(world.stranger, world.topic, world.carol)).toBe(false)
      // 正对照:carol 自己问、话题成员问 carol,都是真 —— 否的是提问的人,不是问题。
      expect(await ask(world.carol, world.topic, world.carol)).toBe(true)
      expect(await ask(world.owner, world.topic, world.carol)).toBe(true)
      // 来源线本身不是话题:这一支对它恒否(那里的可见性走成员关系那一支)。
      expect(await ask(world.carol, world.group, world.carol)).toBe(false)
    })
  })
})
