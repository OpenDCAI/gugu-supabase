import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 任务 agent 进群(迁移 20261022105000_task_agent_passive_join,gugu-dev#181「项目群并入项目页」)。对着跑完全部迁移的真库判:
 *   · 项目群可以只有群主一个人(建项目即建群);
 *   · 任务路径(provision_taskpage_agent)进来的座位是被动档、不出「加入了群聊」,群人数照样 +1;
 *   · 已经在群里的座位不动(档位是群主 / agent 主人定的);
 *   · 别人开了「Agent 加入需审批」的群:任务 agent 排队时记下要被动,群主同意后照它入座(宿主此刻不必在线);
 *   · 正对照:手动拉 agent 进群(add_group_agent)照旧主动、照旧提示 —— 证明判据不是永远绿。
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
  [id, `${id}@task-agent-join.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'task agent fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}

/** 建项目时建的群:只有群主一个人,和客户端走同一个 RPC。 */
async function ownerOnlyGroup(): Promise<string> {
  const id = randomUUID()
  await asUser(owner)
  await database.query(`SELECT chat.create_gugu_group($1,'Project',$2,'[]'::jsonb)`, [id, owner])
  return id
}
async function provision(groupChatId: string, agentId = randomUUID(), caller = owner) {
  await asUser(caller)
  const row = (await database.query<{ group_chat_id: string; prior_group_state: string; group_created: boolean }>(
    'SELECT * FROM identity.provision_taskpage_agent($1,$2,$3,$4,$5,NULL,$6,$7,$8)',
    [agentId, 'Claude', 'serial', 'claude-code', `dev-${caller}`, groupChatId, randomUUID(), 'Project'],
  )).rows[0]!
  return { agentId, row }
}
async function seat(chatId: string, userId: string) {
  await asService()
  return (await database.query<{ listen_mode: string }>(
    'SELECT listen_mode FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [chatId, userId])).rows[0]
}
async function joinNotices(chatId: string): Promise<string[]> {
  await asService()
  return (await database.query<{ client_message_id: string }>(
    `SELECT client_message_id FROM chat.messages WHERE chat_id=$1 AND client_message_id LIKE 'member-joined:%' ORDER BY seq`, [chatId],
  )).rows.map((row) => row.client_message_id)
}
/** 群主开了「Agent 加入需审批」的群,里面有一个普通成员(他不是管理员,他的 agent 进群要排队)。 */
async function approvalGroupWith(member: string): Promise<string> {
  const group = await ownerOnlyGroup()
  await asService()
  await database.query('UPDATE chat.chats SET agent_join_approval = true WHERE id = $1', [group])
  await database.query('SELECT chat.insert_group_member($1,$2)', [group, member])
  return group
}
async function approve(group: string, agentId: string): Promise<{ requested_listen_mode: string }> {
  await asService()
  const request = (await database.query<{ id: string; requested_listen_mode: string }>(
    `SELECT id, requested_listen_mode FROM chat.group_join_requests WHERE chat_id=$1 AND requester_user_id=$2 AND status='pending'`,
    [group, agentId])).rows[0]!
  await asUser(owner)
  await database.query('SELECT chat.decide_group_join($1,true,$2)', [request.id, owner])
  return request
}
async function memberCount(chatId: string): Promise<number> {
  await asService()
  return (await database.query<{ n: number }>('SELECT count(*)::int AS n FROM chat.chat_members WHERE chat_id=$1', [chatId])).rows[0]!.n
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('taskAgentPassiveQuietJoin.test requires a loopback PostgreSQL database')
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

describe('任务 agent 进群', () => {
  it('项目群可以只有群主一个人', async () => {
    const group = await ownerOnlyGroup()
    expect(await memberCount(group)).toBe(1)
  })

  it('进已有的项目群 ⇒ 被动档、不出「加入了群聊」,群人数 +1', async () => {
    const group = await ownerOnlyGroup()
    const { agentId, row } = await provision(group)
    expect(row).toMatchObject({ group_chat_id: group, prior_group_state: 'active', group_created: false })
    expect(await seat(group, agentId)).toEqual({ listen_mode: 'passive' })
    expect(await memberCount(group)).toBe(2)
    expect(await joinNotices(group)).toEqual([])
  })

  it('项目群还不存在 ⇒ 建一个只有群主的群再入座,同样被动、不提示', async () => {
    const group = randomUUID()
    const { agentId, row } = await provision(group)
    expect(row).toMatchObject({ group_chat_id: group, prior_group_state: 'missing', group_created: true })
    expect(await seat(group, agentId)).toEqual({ listen_mode: 'passive' })
    expect(await memberCount(group)).toBe(2)
    expect(await joinNotices(group)).toEqual([])
  })

  it('已经在群里的座位不动:主人改成主动之后再 provision 一次,仍是主动', async () => {
    const group = await ownerOnlyGroup()
    const { agentId } = await provision(group)
    await asUser(owner)
    await database.query('SELECT chat.set_agent_listen_mode_as($1,$2,$3,$4)', [group, agentId, 'active', owner])
    await provision(group, agentId)
    expect((await seat(group, agentId))?.listen_mode).toBe('active')
  })

  it('需审批的群:任务 agent 排队时记下「被动」,群主同意后照它入座,并照常提示', async () => {
    const member = await human('Member')
    const group = await approvalGroupWith(member)
    const { agentId, row } = await provision(group, randomUUID(), member)
    expect(row).toMatchObject({ group_chat_id: '', prior_group_state: 'pending_approval' })
    expect(await seat(group, agentId)).toBeUndefined()
    expect(await approve(group, agentId)).toMatchObject({ requested_listen_mode: 'passive' })
    expect(await seat(group, agentId)).toEqual({ listen_mode: 'passive' })
    expect(await joinNotices(group)).toEqual([
      expect.stringContaining(member),
      expect.stringContaining(agentId),
    ])
  })

  it('正对照:需审批的群里手动拉 agent ⇒ 排队要的是主动,同意后主动入座', async () => {
    const member = await human('Member')
    const group = await approvalGroupWith(member)
    const { agentId } = await provision(randomUUID(), randomUUID(), member)
    await asUser(member)
    await database.query('SELECT chat.add_group_agent($1,$2,NULL,auth.uid()::text)', [group, agentId])
    expect(await approve(group, agentId)).toMatchObject({ requested_listen_mode: 'active' })
    expect(await seat(group, agentId)).toEqual({ listen_mode: 'active' })
  })

  it('正对照:手动拉 agent 进群 ⇒ 主动档,照常出「加入了群聊」', async () => {
    const group = await ownerOnlyGroup()
    const { agentId } = await provision(randomUUID())
    await asUser(owner)
    await database.query('SELECT chat.add_group_agent($1,$2,NULL,auth.uid()::text)', [group, agentId])
    expect(await seat(group, agentId)).toEqual({ listen_mode: 'active' })
    expect(await joinNotices(group)).toEqual([expect.stringContaining(agentId)])
  })
})
