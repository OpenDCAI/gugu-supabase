// @@@6357 群聊悬浮卡 MessagePreview 的中转与 topic 权限 —— 对着真库跑的判官。
//
// 这条迁移给「不是 owner 的人」开了一条通往 agent 宿主设备频道的路。判据要守住三件事:
//   ① 只有「与 agent 同在这个群」的人能让库往宿主那里中转请求;
//   ② 中转过去的请求类型是写死的 taskpage.preview.*,调用方塞不进别的;
//   ③ 预览 topic 只有本群成员读得到、只有 agent 的 owner 写得进。
// 每条否定断言都配一个正对照(同一套装置下的放行),否则「被拒」可能只是我连错了库或身份没设上。
//
// 与 topicAccessControl5856 同形:loopback PostgreSQL、`GUGU_INTEGRATION_DATABASE_URL`,每条用例 BEGIN…ROLLBACK。
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
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`messagePreviewRelay6357.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
}

function uid(n: number): string {
  return `6357aaaa-aaaa-4000-8000-${String(n).padStart(12, '0')}`
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

async function rejection(sql: string, values: unknown[]): Promise<string> {
  await database.query('SAVEPOINT probe')
  try {
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT probe')
    return String((error as Error)?.message ?? error)
  }
  await database.query('RELEASE SAVEPOINT probe')
  throw new Error(`expected this to be rejected, but it succeeded: ${sql}`)
}

beforeAll(async () => {
  requireLoopbackDatabase()
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})
afterAll(async () => { await database?.end() })

const owner = uid(1) // agent 的 owner
const viewer = uid(2) // 群里的另一个人
const outsider = uid(3) // 不在群里
const agent = uid(11)
const loner = uid(12) // 另一个 agent,不在这个群
const group = uid(21)
const otherGroup = uid(22)
const DEVICE = 'dev-6357'

async function seed(): Promise<void> {
  await database.query(
    `INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','Owner'),($2,'human','Viewer'),($3,'human','Outsider')`,
    [owner, viewer, outsider],
  )
  await database.query(
    `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ($1,$2,'本机','mbp','darwin')`,
    [DEVICE, owner],
  )
  await database.query(
    `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id)
     VALUES ($1,'agent','Claude 11',$3,$4),($2,'agent','Loner',$3,$4)`,
    [agent, loner, owner, DEVICE],
  )
  await database.query(
    `INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','MessagePreviewAPI',$3),($2,'group','A 群',$3)`,
    [group, otherGroup, owner],
  )
  await database.query(
    `INSERT INTO chat.chat_members (chat_id, user_id, role)
     VALUES ($1,$3,'owner'),($1,$4,'member'),($1,$5,'member'),($2,$3,'owner'),($2,$6,'member')`,
    [group, otherGroup, owner, viewer, agent, loner],
  )
}

const TOPIC = `gugu:preview:${group}:${agent}`

async function relayedRequests(): Promise<Array<{ payload: Record<string, unknown> }>> {
  await asService()
  const { rows } = await database.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM realtime.messages WHERE topic = $1 ORDER BY inserted_at, id`,
    [`gugu:${DEVICE}:rpc`],
  )
  return rows
}

describe('#6357 MessagePreview 中转(对着真库跑)', () => {
  it('同群成员:中转一条固定类型的请求到 agent 宿主的设备频道,带上群号', async () => {
    await inRollback(async () => {
      await seed()
      await asUser(viewer)
      const { rows } = await database.query<{ result: { topic: string } }>(
        `SELECT chat.message_preview_subscribe($1,$2,'sub-1') AS result`,
        [group, agent],
      )
      expect(rows[0]!.result).toEqual({ topic: TOPIC })
      const relayed = await relayedRequests()
      expect(relayed).toHaveLength(1)
      const { rows: chatRows } = await database.query<{ public_id: number }>(
        `SELECT public_id FROM chat.chats WHERE id = $1`, [group],
      )
      expect(relayed[0]!.payload).toMatchObject({
        type: 'taskpage.preview.subscribe',
        user_id: viewer,
        payload: { chatId: group, agentId: agent, subscriptionId: 'sub-1', chatPublicId: chatRows[0]!.public_id, topic: TOPIC },
      })

      await asUser(viewer)
      await database.query(`SELECT chat.message_preview_keepalive($1,$2,'sub-1')`, [group, agent])
      await asUser(viewer)
      await database.query(`SELECT chat.message_preview_unsubscribe($1,$2,'sub-1')`, [group, agent])
      // 同一事务里 inserted_at 相同、id 是随机 uuid ⇒ 行序不代表发送序,按集合比。
      const types = (await relayedRequests()).map((row) => String(row.payload.type)).sort()
      expect(types).toEqual(['taskpage.preview.keepalive', 'taskpage.preview.subscribe', 'taskpage.preview.unsubscribe'])
    })
  })

  it('不在群里的人:拒,且什么都没中转(正对照 = 上一条)', async () => {
    await inRollback(async () => {
      await seed()
      await asUser(outsider)
      const error = await rejection(`SELECT chat.message_preview_subscribe($1,$2,'sub-x')`, [group, agent])
      expect(error).toMatch(/not a member of chat/)
      expect(await relayedRequests()).toHaveLength(0)
    })
  })

  it('agent 不在这个群:拒(不能借本群去看别的群里的 agent)', async () => {
    await inRollback(async () => {
      await seed()
      await asUser(viewer)
      const error = await rejection(`SELECT chat.message_preview_subscribe($1,$2,'sub-x')`, [group, loner])
      expect(error).toMatch(/is not a member of chat/)
      expect(await relayedRequests()).toHaveLength(0)
    })
  })

  it('对象不是 agent(是个人):拒', async () => {
    await inRollback(async () => {
      await seed()
      await asUser(viewer)
      const error = await rejection(`SELECT chat.message_preview_subscribe($1,$2,'sub-x')`, [group, owner])
      expect(error).toMatch(/has no host device/)
    })
  })

  it('中转内核不对外:authenticated 直接调 message_preview_relay 塞别的动词 → 无权限', async () => {
    await inRollback(async () => {
      await seed()
      await asUser(viewer)
      const error = await rejection(
        `SELECT chat.message_preview_relay($1,$2,'sub-x','session.send')`,
        [group, agent],
      )
      expect(error).toMatch(/permission denied/)
    })
  })

  it('空订阅 id:拒', async () => {
    await inRollback(async () => {
      await seed()
      await asUser(viewer)
      const error = await rejection(`SELECT chat.message_preview_subscribe($1,$2,'  ')`, [group, agent])
      expect(error).toMatch(/subscription id is required/)
    })
  })
})

describe('#6357 预览 topic 的读写策略', () => {
  async function insertAs(userId: string, topic: string): Promise<void> {
    await asUser(userId)
    await database.query(
      `INSERT INTO realtime.messages (topic, extension, event, payload, private) VALUES ($1,'broadcast','preview','{}'::jsonb,true)`,
      [topic],
    )
  }
  async function visibleTo(userId: string, topic: string): Promise<number> {
    await asUser(userId)
    const { rows } = await database.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM realtime.messages WHERE topic = $1`, [topic],
    )
    return Number(rows[0]!.n)
  }

  it('写:只有 agent 的 owner;群里的别人写不进', async () => {
    await inRollback(async () => {
      await seed()
      await insertAs(owner, TOPIC) // 正对照
      await asUser(viewer)
      const error = await rejection(
        `INSERT INTO realtime.messages (topic, extension, event, payload, private) VALUES ($1,'broadcast','preview','{}'::jsonb,true)`,
        [TOPIC],
      )
      expect(error).toMatch(/row-level security/)
    })
  })

  it('读:本群成员读得到,群外的人读不到', async () => {
    await inRollback(async () => {
      await seed()
      await insertAs(owner, TOPIC)
      expect(await visibleTo(viewer, TOPIC)).toBe(1) // 正对照
      expect(await visibleTo(outsider, TOPIC)).toBe(0)
    })
  })

  it('agent 不在的群:owner 也写不进那个群的预览 topic', async () => {
    await inRollback(async () => {
      await seed()
      await asUser(owner)
      const error = await rejection(
        `INSERT INTO realtime.messages (topic, extension, event, payload, private) VALUES ($1,'broadcast','preview','{}'::jsonb,true)`,
        [`gugu:preview:${otherGroup}:${agent}`],
      )
      expect(error).toMatch(/row-level security/)
    })
  })

  it('owner 本人不在的群(别人把他的 agent 拉进了自己的群):owner 读得到 → 宿主加入得了频道;群外的人仍读不到', async () => {
    await inRollback(async () => {
      await seed()
      const viewersGroup = uid(23)
      await database.query(
        `INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','Viewer 的群',$2)`,
        [viewersGroup, viewer],
      )
      await database.query(
        `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'owner'),($1,$3,'member')`,
        [viewersGroup, viewer, agent],
      )
      const topic = `gugu:preview:${viewersGroup}:${agent}`
      await insertAs(owner, topic) // 写:owner(不在群里)写得进
      expect(await visibleTo(owner, topic)).toBe(1) // 读:owner 读得到(加入频道的前提)
      expect(await visibleTo(viewer, topic)).toBe(1) // 群成员读得到
      expect(await visibleTo(outsider, topic)).toBe(0) // 群外、又不是 owner:读不到
    })
  })
})
