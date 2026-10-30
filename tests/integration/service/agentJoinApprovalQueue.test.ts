import { createFixtureGroup } from '../../support/groupFixture'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 「Agent 加入需审批」= 真正的审批队列(迁移 20260924074100,owner 2026-09-23 拍板走 B)。
 *   · 非管理员把自己的 agent 拉进开了审批的群 ⇒ 不入群、落一条待审请求(add_group_agent / agent 邀请 / 会话进项目群);
 *   · 管理员在待审列表里看得到「谁替哪个 agent 发起」,批准时按同一道判定重跑(人数上限等);
 *   · 拒绝后发起人读得到结果;发起人退群后批准失败。
 * 每条否定断言配正对照;每条用例 BEGIN…ROLLBACK。
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
let admin: string
let member: string
let memberAgent: string
let ownerAgent: string

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asService() { await database.query('RESET role') }
async function fails(sql: string, values: unknown[] = []): Promise<string> {
  await database.query('SAVEPOINT expected_failure')
  try {
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT expected_failure')
    return String((error as Error).message)
  }
  await database.query('RELEASE SAVEPOINT expected_failure')
  throw new Error(`expected failure, but succeeded: ${sql}`)
}
async function human(name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@approval-queue.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'queue fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}
async function agentOf(ownerId: string, name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, agent_public, device_id)
    VALUES ($1,'agent',$2,$3,true,$4)`, [id, name, ownerId, `dev-${ownerId}`])
  return id
}
async function newGroup(settings: Record<string, unknown> = { agent_join_approval: true }): Promise<string> {
  const id = randomUUID()
  await asUser(owner)
  await createFixtureGroup(database, [
    id, 'Approval queue', owner, JSON.stringify([{ user_id: ownerAgent, role: 'member' }]),
  ])
  await asService()
  await database.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'admin'),($1,$3,'member')`, [id, admin, member])
  const keys = Object.keys(settings)
  await database.query(
    `UPDATE chat.chats SET ${keys.map((key, i) => `${key} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [id, ...keys.map((key) => settings[key])],
  )
  return id
}
async function isMember(chatId: string, userId: string): Promise<boolean> {
  await asService()
  return (await database.query('SELECT 1 FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [chatId, userId])).rows.length === 1
}
async function addAgent(actor: string, chatId: string, agentId: string) {
  await asUser(actor)
  return (await database.query<{ result: { status: string; request_id?: string } }>(
    'SELECT chat.add_group_agent($1,$2,$3,auth.uid()::text) AS result', [chatId, agentId, '请让它帮忙评审'])).rows[0]!.result
}
async function pendingFor(manager: string, chatId: string) {
  await asUser(manager)
  return (await database.query<{ id: string; requester_user_id: string; requester_type: string; requested_by_user_id: string | null; requested_by_name: string | null }>(
    'SELECT * FROM chat.list_group_join_requests($1,false,auth.uid()::text)', [chatId])).rows
}
async function mine(actor: string, chatId: string) {
  await asUser(actor)
  return (await database.query<{ agent_user_id: string; status: string }>(
    'SELECT agent_user_id, status FROM chat.list_my_agent_join_requests($1)', [chatId])).rows
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('agentJoinApprovalQueue.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human('Owner'); admin = await human('Admin'); member = await human('Member')
  memberAgent = await agentOf(member, 'Member Agent')
  ownerAgent = await agentOf(owner, 'Owner Agent')
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

describe('Agent 加入需审批 = 审批队列', () => {
  it('非管理员拉 agent ⇒ 待审而不入群;关掉审批 ⇒ 直接入群(正对照)', async () => {
    const group = await newGroup()
    expect(await addAgent(member, group, memberAgent)).toMatchObject({ status: 'pending_approval' })
    expect(await isMember(group, memberAgent)).toBe(false)
    expect(await mine(member, group)).toEqual([{ agent_user_id: memberAgent, status: 'pending' }])
    const other = await newGroup({ agent_join_approval: false })
    expect(await addAgent(member, other, memberAgent)).toMatchObject({ status: 'joined' })
    expect(await isMember(other, memberAgent)).toBe(true)
  })

  it('管理员自己的 agent 不进队列', async () => {
    const group = await newGroup()
    const adminAgent = await agentOf(admin, 'Admin Agent')
    expect(await addAgent(admin, group, adminAgent)).toMatchObject({ status: 'joined' })
  })

  it('管理员看到「谁替哪个 agent 发起」,批准后入群;拒绝后发起人看得到结果', async () => {
    const group = await newGroup()
    await addAgent(member, group, memberAgent)
    const [request] = await pendingFor(admin, group)
    expect(request).toMatchObject({ requester_user_id: memberAgent, requester_type: 'agent', requested_by_user_id: member, requested_by_name: 'Member' })
    await asUser(admin)
    await database.query('SELECT chat.decide_group_join($1,true,auth.uid()::text)', [request!.id])
    expect(await isMember(group, memberAgent)).toBe(true)
    expect(await mine(member, group)).toEqual([{ agent_user_id: memberAgent, status: 'accepted' }])

    const second = await agentOf(member, 'Second Agent')
    await addAgent(member, group, second)
    const [again] = await pendingFor(owner, group)
    await asUser(owner)
    await database.query('SELECT chat.decide_group_join($1,false,auth.uid()::text)', [again!.id])
    expect(await isMember(group, second)).toBe(false)
    expect((await mine(member, group)).find((row) => row.agent_user_id === second)?.status).toBe('rejected')
  })

  it('已处理的请求:默认只列待审(已发布的客户端不变),p_include_decided 连同状态一起列(#6704)', async () => {
    const group = await newGroup()
    const [accepted, rejected, waiting] = [memberAgent, await agentOf(member, 'Rejected Agent'), await agentOf(member, 'Waiting Agent')]
    for (const agent of [accepted, rejected, waiting]) await addAgent(member, group, agent)
    const idOf = new Map((await pendingFor(owner, group)).map((row) => [row.requester_user_id, row.id]))
    await asUser(owner)
    await database.query('SELECT chat.decide_group_join($1,true,auth.uid()::text)', [idOf.get(accepted)])
    await database.query('SELECT chat.decide_group_join($1,false,auth.uid()::text)', [idOf.get(rejected)])
    expect((await pendingFor(owner, group)).map((row) => row.requester_user_id)).toEqual([waiting])
    await asUser(owner)
    const { rows } = await database.query<{ requester_user_id: string; status: string }>(
      'SELECT requester_user_id, status FROM chat.list_group_join_requests($1, true,auth.uid()::text)', [group])
    expect(Object.fromEntries(rows.map((row) => [row.requester_user_id, row.status])))
      .toEqual({ [accepted]: 'accepted', [rejected]: 'rejected', [waiting]: 'pending' })
    await asUser(member)
    expect(await fails('SELECT * FROM chat.list_group_join_requests($1, true,auth.uid()::text)', [group])).toMatch(/group_manager_required/)
  })

  it('普通成员看不到、也批不了待审', async () => {
    const group = await newGroup()
    await addAgent(member, group, memberAgent)
    await asUser(member)
    expect(await fails('SELECT * FROM chat.list_group_join_requests($1,false,auth.uid()::text)', [group])).toMatch(/group_manager_required/)
    await asService()
    const id = (await database.query<{ id: string }>('SELECT id FROM chat.group_join_requests WHERE chat_id=$1', [group])).rows[0]!.id
    await asUser(member)
    expect(await fails('SELECT chat.decide_group_join($1,true,auth.uid()::text)', [id])).toMatch(/group_manager_required/)
  })

  it('批准时重查人数上限:满了拒,放宽后再批就过', async () => {
    const group = await newGroup()
    await addAgent(member, group, memberAgent)
    const [request] = await pendingFor(owner, group)
    await asService()
    await database.query('UPDATE chat.chats SET max_members = 4 WHERE id = $1', [group]) // 已有 4 人
    await asUser(owner)
    expect(await fails('SELECT chat.decide_group_join($1,true,auth.uid()::text)', [request!.id])).toMatch(/member_limit_reached/)
    expect(await isMember(group, memberAgent)).toBe(false)
    await asService()
    await database.query('UPDATE chat.chats SET max_members = 5 WHERE id = $1', [group])
    await asUser(owner)
    await database.query('SELECT chat.decide_group_join($1,true,auth.uid()::text)', [request!.id])
    expect(await isMember(group, memberAgent)).toBe(true)
  })

  it('发起人等待期间退群 ⇒ 批准失败', async () => {
    const group = await newGroup()
    await addAgent(member, group, memberAgent)
    const [request] = await pendingFor(owner, group)
    await asService()
    await database.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [group, member])
    await asUser(owner)
    expect(await fails('SELECT chat.decide_group_join($1,true,auth.uid()::text)', [request!.id])).toMatch(/join_request_requester_left/)
  })

  it('agent 发起的邀请(自有 agent)也进同一条队列', async () => {
    // 群允许成员邀请(否则邀请这一步就被拒),但 agent 入群仍需审批。
    const group = await newGroup({ agent_join_approval: true, allow_member_invite: true })
    await asService()
    await database.query("INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member')", [group, memberAgent])
    const second = await agentOf(member, 'Invitee Agent')
    await asUser(member)
    const result = (await database.query<{ result: { status: string } }>(
      'SELECT chat.request_group_invitation_as($1,$3,$4,$2) AS result', [group, memberAgent, second, '一起评审'])).rows[0]!.result
    expect(result.status).toBe('pending_approval')
    expect(await isMember(group, second)).toBe(false)
    expect((await pendingFor(owner, group)).map((row) => row.requester_user_id)).toEqual([second])
  })

  it('RLS 直插仍不能绕过审批(客户端必须走 add_group_agent)', async () => {
    const group = await newGroup()
    await asUser(member)
    expect(await fails('INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,\'member\')', [group, memberAgent]))
      .toMatch(/permission denied/)
  })
})
