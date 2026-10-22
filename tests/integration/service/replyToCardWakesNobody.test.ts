import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 回复一张卡片,谁也不叫醒(迁移 20261022151000_reply_to_card_wakes_nobody,gugu-dev#181 原型 ⑨)。
 *
 * agent 的问题是它发进群里的一张卡;主人在群里引用这张卡回复,答案经会话的答问通道到 agent。这条回复要是再按
 * 「回复了 agent 的消息 = 点名它」叫醒 agent,同一个答案就会到两次。拉取(message_agent_wakes)和推送
 * (agent.deliver 设备指令)两头都判:
 *   · 引用 agent 发的卡片回复 ⇒ 两头都不叫醒;
 *   · 正对照:引用 agent 发的普通消息回复 ⇒ 两头都叫醒 —— 证明判据能产出相反的结果;
 *   · 引用主人自己发的任务卡回复 ⇒ 和原来一样,谁也不叫醒。
 * 每条用例 BEGIN…ROLLBACK。
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient
let owner: string
let agent: string
let group: string

async function inRollback(body: () => Promise<void>): Promise<void> {
  await database.query('BEGIN')
  try {
    await seed()
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

async function seed(): Promise<void> {
  owner = randomUUID()
  agent = randomUUID()
  group = randomUUID()
  const device = `dev-${owner}`
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','owner')`, [owner])
  await database.query(
    `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ($1,$2,'reply-card','reply-card','darwin')`,
    [device, owner],
  )
  await database.query(
    `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id) VALUES ($1,'agent','claude',$2,$3)`,
    [agent, owner, device],
  )
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','project',$2)`, [group, owner])
  // 主动档:没点名的话它也会被叫醒,所以下面「不叫醒」只能是回复卡片那条规则挡的。
  await database.query(
    `INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode) VALUES ($1,$2,'owner','active'),($1,$3,'member','active')`,
    [group, owner, agent],
  )
}

async function post(sender: string, contentType: 'text' | 'card', replyTo: string | null = null): Promise<string> {
  const id = randomUUID()
  await database.query(
    `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, reply_to_message_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, group, sender, contentType === 'card' ? '{"v":1,"type":"question","text":"用哪个配色?"}' : '用第二个', contentType, replyTo],
  )
  return id
}

async function woken(messageId: string): Promise<{ pulled: string[]; pushed: string[] }> {
  const pulled = (await database.query<{ agent_user_id: string }>(
    'SELECT agent_user_id FROM chat.message_agent_wakes WHERE message_id = $1', [messageId])).rows.map((row) => row.agent_user_id)
  const pushed = (await database.query<{ agent_user_id: string }>(
    `SELECT payload->>'agent_user_id' AS agent_user_id FROM identity.gugu_device_commands
      WHERE type = 'agent.deliver' AND payload->>'message_id' = $1`, [messageId])).rows.map((row) => row.agent_user_id)
  return { pulled, pushed }
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('replyToCardWakesNobody.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })

describe('回复一张卡片,谁也不叫醒', () => {
  it('主人引用 agent 发的卡片回复 ⇒ 拉取、推送都不叫醒 agent', () => inRollback(async () => {
    const card = await post(agent, 'card')
    const reply = await post(owner, 'text', card)
    expect(await woken(reply)).toEqual({ pulled: [], pushed: [] })
  }))

  it('正对照:主人引用 agent 发的普通消息回复 ⇒ 拉取、推送都叫醒 agent', () => inRollback(async () => {
    const said = await post(agent, 'text')
    const reply = await post(owner, 'text', said)
    expect(await woken(reply)).toEqual({ pulled: [agent], pushed: [agent] })
  }))

  it('主人引用自己发的任务卡回复 ⇒ 谁也不叫醒(和原来一样)', () => inRollback(async () => {
    const taskCard = await post(owner, 'card')
    const reply = await post(owner, 'text', taskCard)
    expect(await woken(reply)).toEqual({ pulled: [], pushed: [] })
  }))
})
