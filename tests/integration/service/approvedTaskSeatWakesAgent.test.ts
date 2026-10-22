import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 审批通过的任务座位叫醒它交结果(迁移 20261022152000_approved_task_seat_wakes_agent,gugu-dev#181 核对 80b)。
 *
 * 开了「Agent 加入需审批」的群里派任务:任务 agent 先排队(请求要 passive),结果先回在它自己的会话里。群主同意时,
 * 入群那一行「X 加入了群聊」点名这个 agent,拉取(message_agent_wakes)和推送(agent.deliver)两头都叫醒它,而且只叫醒它:
 *   · 任务座位被批准 ⇒ 那一行的收件人是它,两头都叫醒它;同群另一个主动档的 agent 不被叫醒;
 *   · 正对照:同一条审批路径,普通 agent(请求要 active)被批准 ⇒ 那一行不点名,谁也不叫醒(#6860 照旧);
 *   · 被拒 ⇒ 不写入群那一行,也不叫醒它。
 * 每条用例 BEGIN…ROLLBACK,提交前先 SET CONSTRAINTS ALL IMMEDIATE 核一遍延迟约束。
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

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asService() { await database.query('RESET role') }

async function human(name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@approved-task-seat.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'approved task seat fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}

/** 和客户端同一个 RPC 建一个 agent(任务路径);groupChatId 是它的项目群,这里只为拿到一个 agent。 */
async function agentOf(caller: string, groupChatId = randomUUID()): Promise<string> {
  const agentId = randomUUID()
  await asUser(caller)
  await database.query('SELECT * FROM identity.provision_taskpage_agent($1,$2,$3,$4,$5,NULL,$6,$7,$8)',
    [agentId, 'Claude', 'serial', 'claude-code', `dev-${caller}`, groupChatId, randomUUID(), 'Project'])
  return agentId
}
/** 群主开了「Agent 加入需审批」的群,里面有一个普通成员(他不是管理员,他的 agent 进群要排队)。 */
async function approvalGroupWith(member: string): Promise<string> {
  const group = randomUUID()
  await asUser(owner)
  await database.query(`SELECT chat.create_gugu_group($1,'Approval',$2,'[]'::jsonb)`, [group, owner])
  await asService()
  await database.query('UPDATE chat.chats SET agent_join_approval = true WHERE id = $1', [group])
  await database.query('SELECT chat.insert_group_member($1,$2)', [group, member])
  return group
}
/** 成员在需审批的群里派任务:任务 agent 进群排队,要 passive(与客户端同一个 RPC)。 */
async function dispatchTask(group: string, member: string): Promise<string> {
  const agentId = randomUUID()
  await asUser(member)
  const row = (await database.query<{ prior_group_state: string }>(
    'SELECT * FROM identity.provision_taskpage_agent($1,$2,$3,$4,$5,NULL,$6,$7,$8)',
    [agentId, 'Claude', 'serial', 'claude-code', `dev-${member}`, group, randomUUID(), 'Approval'],
  )).rows[0]!
  expect(row.prior_group_state).toBe('pending_approval')
  return agentId
}
async function decide(group: string, agentId: string, accept: boolean): Promise<string> {
  await asService()
  const request = (await database.query<{ id: string; requested_listen_mode: string }>(
    `SELECT id, requested_listen_mode FROM chat.group_join_requests WHERE chat_id=$1 AND requester_user_id=$2 AND status='pending'`,
    [group, agentId])).rows[0]!
  await asUser(owner)
  await database.query('SELECT chat.decide_group_join($1,$2,$3)', [request.id, accept, owner])
  return request.requested_listen_mode
}
async function joinRowOf(group: string, userId: string): Promise<{ id: string; to_user_ids: string[] | null } | undefined> {
  await asService()
  return (await database.query<{ id: string; to_user_ids: string[] | null }>(
    `SELECT id, to_user_ids FROM chat.messages WHERE chat_id=$1 AND client_message_id LIKE 'member-joined:%:' || $2`,
    [group, userId])).rows[0]
}
async function woken(messageId: string): Promise<{ pulled: string[]; pushed: string[] }> {
  await asService()
  const pulled = (await database.query<{ agent_user_id: string }>(
    'SELECT agent_user_id FROM chat.message_agent_wakes WHERE message_id = $1 ORDER BY agent_user_id', [messageId]))
    .rows.map((row) => row.agent_user_id)
  const pushed = (await database.query<{ agent_user_id: string }>(
    `SELECT payload->>'agent_user_id' AS agent_user_id FROM identity.gugu_device_commands
      WHERE type = 'agent.deliver' AND payload->>'message_id' = $1 ORDER BY 1`, [messageId]))
    .rows.map((row) => row.agent_user_id)
  return { pulled, pushed }
}
/** 这个 agent 在这个群里被叫醒过几次(拉取、推送各数各的)。 */
async function wakesIn(group: string, agentId: string): Promise<{ pulled: number; pushed: number }> {
  await asService()
  const pulled = (await database.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM chat.message_agent_wakes w JOIN chat.messages m ON m.id = w.message_id
      WHERE m.chat_id = $1 AND w.agent_user_id = $2`, [group, agentId])).rows[0]!.n
  const pushed = (await database.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM identity.gugu_device_commands
      WHERE type = 'agent.deliver' AND payload->>'chat_id' = $1 AND payload->>'agent_user_id' = $2`, [group, agentId])).rows[0]!.n
  return { pulled, pushed }
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('approvedTaskSeatWakesAgent.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human('Owner')
})
afterEach(async () => {
  if (!database) return
  try {
    await asService()
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await database.query('ROLLBACK')
  }
})

describe('审批通过的任务座位叫醒它交结果', () => {
  it('任务座位被批准 ⇒ 入群那一行点名它,拉取、推送都叫醒它,同群另一个主动档的 agent 不被叫醒', async () => {
    const member = await human('Member')
    const group = await approvalGroupWith(member)
    // 群主自己的 agent 直接进群、主动档:一句没点名的人话会叫醒它,所以下面它没被叫醒只能是因为那一行点了别人。
    const bystander = await agentOf(owner)
    await asUser(owner)
    await database.query('SELECT chat.add_group_agent($1,$2,NULL,auth.uid()::text)', [group, bystander])
    const task = await dispatchTask(group, member)

    expect(await decide(group, task, true)).toBe('passive')
    const row = await joinRowOf(group, task)
    expect(row?.to_user_ids).toEqual([task])
    expect(await woken(row!.id)).toEqual({ pulled: [task], pushed: [task] })
  })

  it('正对照:同一条审批路径,普通 agent(请求要 active)被批准 ⇒ 那一行不点名,谁也不叫醒', async () => {
    const member = await human('Member')
    const group = await approvalGroupWith(member)
    const agent = await agentOf(member)
    await asUser(member)
    await database.query('SELECT chat.add_group_agent($1,$2,NULL,auth.uid()::text)', [group, agent])

    expect(await decide(group, agent, true)).toBe('active')
    const row = await joinRowOf(group, agent)
    expect(row?.to_user_ids).toBeNull()
    expect(await woken(row!.id)).toEqual({ pulled: [], pushed: [] })
  })

  it('任务座位被拒 ⇒ 不写入群那一行,也不叫醒它', async () => {
    const member = await human('Member')
    const group = await approvalGroupWith(member)
    const task = await dispatchTask(group, member)

    expect(await decide(group, task, false)).toBe('passive')
    expect(await joinRowOf(group, task)).toBeUndefined()
    expect(await wakesIn(group, task)).toEqual({ pulled: 0, pushed: 0 })
  })
})
