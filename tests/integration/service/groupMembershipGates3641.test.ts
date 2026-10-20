import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 群设置「规则基本不生效」的数据库那一半(迁移 20260924074000)。对着跑完全部迁移的真库判:
 *   ① 统一的「能否加此人」:管理员豁免、role 约束、上限、agent 审批(RLS 直插与各 RPC 同一口径);
 *   ② join_public_group 不再能用邀请 token 绕过「需审批 / 仅邀请」;
 *   ③ provision_taskpage_agent 不再能往别人的群塞 agent;
 *   ④ create_topic 不再能把「需审批」群外的 agent 带进来;
 *   ⑤ message_history_as / message_search_as 按 agent 自己的可见域(隐藏聊天记录)过滤。
 * 每条否定断言都配正对照(同一夹具只翻一个开关就放行),证明判据不是永远红。
 * 每条用例 BEGIN…ROLLBACK,提交前先 SET CONSTRAINTS ALL IMMEDIATE 核一遍延迟约束。
 * 跑法:`GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:<port>/postgres pnpm exec vitest run --project integration groupMembershipGates3641`
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
let outsider: string
let friend: string
let memberAgent: string
let ownerAgent: string
let outsiderAgent: string

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
  [id, `${id}@gates-3641.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'gates fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}
async function agentOf(ownerId: string, name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, agent_public, device_id)
    VALUES ($1,'agent',$2,$3,true,$4)`, [id, name, ownerId, `dev-${ownerId}`])
  return id
}

/** owner 建群(owner + ownerAgent),再以服务身份把 admin / member 放进去;设置按参数改。 */
async function newGroup(settings: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await asUser(owner)
  await database.query('SELECT chat.create_gugu_group($1,$2,$3,$4::jsonb)', [
    id, 'Gates 3641', owner, JSON.stringify([{ user_id: ownerAgent, role: 'member' }]),
  ])
  await asService()
  await database.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'admin'),($1,$3,'member')`, [id, admin, member])
  const keys = Object.keys(settings)
  if (keys.length) {
    await database.query(
      `UPDATE chat.chats SET ${keys.map((key, i) => `${key} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [id, ...keys.map((key) => settings[key])],
    )
  }
  return id
}
async function isMember(chatId: string, userId: string): Promise<boolean> {
  await asService()
  return (await database.query('SELECT 1 FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [chatId, userId])).rows.length === 1
}
async function insertMember(actor: string, chatId: string, userId: string, role = 'member') {
  await asUser(actor)
  await database.query('INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,$3)', [chatId, userId, role])
}
async function insertFails(actor: string, chatId: string, userId: string, role = 'member') {
  await asUser(actor)
  return fails('INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,$3)', [chatId, userId, role])
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('groupMembershipGates3641.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human('Owner'); admin = await human('Admin'); member = await human('Member')
  outsider = await human('Outsider'); friend = await human('Friend')
  memberAgent = await agentOf(member, 'Member Agent')
  ownerAgent = await agentOf(owner, 'Owner Agent')
  outsiderAgent = await agentOf(outsider, 'Outsider Agent')
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

describe('① 统一的「能否加此人」(RLS 直插)', () => {
  it('管理员不受「允许成员邀请」约束;普通成员受(开关一开即放行)', async () => {
    const group = await newGroup({ allow_member_invite: false })
    await insertMember(admin, group, friend)
    expect(await isMember(group, friend)).toBe(true)
    const other = await human('Other')
    expect(await insertFails(member, group, other)).toMatch(/row-level security/)
    await asService()
    await database.query('UPDATE chat.chats SET allow_member_invite = true WHERE id = $1', [group])
    await insertMember(member, group, other)
    expect(await isMember(group, other)).toBe(true)
  })

  it('普通成员不能直接写 role=admin(即使允许邀请);管理员可以', async () => {
    const group = await newGroup({ allow_member_invite: true })
    expect(await insertFails(member, group, friend, 'admin')).toMatch(/row-level security/)
    expect(await insertFails(member, group, friend, 'owner')).toMatch(/row-level security/)
    await insertMember(admin, group, friend, 'admin')
    await asService()
    const role = (await database.query<{ role: string }>('SELECT role FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [group, friend])).rows[0]?.role
    expect(role).toBe('admin')
  })

  it('上限对群主同样生效(以前创建者整条豁免)', async () => {
    const group = await newGroup({ max_members: 4 }) // owner + ownerAgent + admin + member = 4
    // BEFORE INSERT 触发器(①b)先于 RLS WITH CHECK 执行,所以满员报的是它的稳定标识。
    expect(await insertFails(owner, group, friend)).toMatch(/member_limit_reached/)
    await asService()
    await database.query('UPDATE chat.chats SET max_members = 5 WHERE id = $1', [group])
    await insertMember(owner, group, friend)
    expect(await isMember(group, friend)).toBe(true)
  })

  it('「agent 加入需审批」拦普通成员加自己的 agent;关掉即放行;管理员不受拦', async () => {
    const group = await newGroup({ agent_join_approval: true })
    expect(await insertFails(member, group, memberAgent)).toMatch(/row-level security/)
    const adminAgent = await agentOf(admin, 'Admin Agent')
    await insertMember(admin, group, adminAgent)
    expect(await isMember(group, adminAgent)).toBe(true)
    await asService()
    await database.query('UPDATE chat.chats SET agent_join_approval = false WHERE id = $1', [group])
    await insertMember(member, group, memberAgent)
    expect(await isMember(group, memberAgent)).toBe(true)
  })

  it('管理员 / 群主也不能把别人的 agent 直插进群(agent_not_owned);管理员加自己的 agent 不受审批开关限制', async () => {
    const group = await newGroup({ agent_join_approval: true, allow_member_invite: true })
    // 别人的 agent:主人在群里(member)与不在群里(outsider)两种,管理员与群主都拒。
    expect(await insertFails(admin, group, memberAgent)).toMatch(/row-level security/)
    expect(await insertFails(admin, group, outsiderAgent)).toMatch(/row-level security/)
    expect(await insertFails(owner, group, memberAgent)).toMatch(/row-level security/)
    expect(await isMember(group, memberAgent)).toBe(false)
    expect(await isMember(group, outsiderAgent)).toBe(false)
    // 判据本身:拒因是归属,不是审批开关 —— 关掉审批仍拒。
    await asService()
    expect((await database.query<{ denial: string }>('SELECT chat.group_add_denial($1,$2,$3) AS denial', [group, memberAgent, admin])).rows[0]?.denial)
      .toBe('agent_not_owned')
    await database.query('UPDATE chat.chats SET agent_join_approval = false WHERE id = $1', [group])
    expect(await insertFails(admin, group, memberAgent)).toMatch(/row-level security/)
    // 正对照:管理员自己的 agent 在开着审批的群里照样直接进;主人自己加自己的 agent 也进。
    await asService()
    await database.query('UPDATE chat.chats SET agent_join_approval = true WHERE id = $1', [group])
    const adminAgent = await agentOf(admin, 'Admin Agent')
    await insertMember(admin, group, adminAgent)
    expect(await isMember(group, adminAgent)).toBe(true)
    await asService()
    await database.query('UPDATE chat.chats SET agent_join_approval = false WHERE id = $1', [group])
    await insertMember(member, group, memberAgent)
    expect(await isMember(group, memberAgent)).toBe(true)
  })

  it('create_gugu_group:初始成员里带别人的 agent ⇒ agent_not_owned;自己的 agent 正常', async () => {
    await asUser(owner)
    expect(await fails('SELECT chat.create_gugu_group($1,$2,$3,$4::jsonb)', [
      randomUUID(), 'Foreign agent', owner, JSON.stringify([{ user_id: outsiderAgent, role: 'member' }]),
    ])).toMatch(/agent_not_owned/)
    await database.query('SELECT chat.create_gugu_group($1,$2,$3,$4::jsonb)', [
      randomUUID(), 'Own agent', owner, JSON.stringify([{ user_id: ownerAgent, role: 'member' }]),
    ])
  })

  it('非成员什么都加不进去', async () => {
    const group = await newGroup({ allow_member_invite: true })
    expect(await insertFails(outsider, group, outsider)).toMatch(/row-level security/)
    expect(await insertFails(outsider, group, outsiderAgent)).toMatch(/row-level security/)
  })

  it('话题直插只收来源线成员(以前话题创建者能把任何人塞进来)', async () => {
    const group = await newGroup()
    const source = randomUUID()
    await asService()
    await database.query(`INSERT INTO chat.messages (id,chat_id,sender_user_id,content,content_type)
      VALUES ($1,$2,$3,'anchor','text')`, [source, group, owner])
    await asUser(owner)
    const topic = (await database.query<{ chat_id: string }>('SELECT * FROM chat.create_topic($1,$2)', [group, source])).rows[0]!.chat_id
    expect(await insertFails(owner, topic, outsider)).toMatch(/row-level security/)
    await insertMember(owner, topic, member)
    expect(await isMember(topic, member)).toBe(true)
  })

  it('create_gugu_group:初始成员不能带 owner 角色', async () => {
    await asUser(owner)
    const message = await fails('SELECT chat.create_gugu_group($1,$2,$3,$4::jsonb)', [
      randomUUID(), 'Two owners', owner, JSON.stringify([{ user_id: friend, role: 'owner' }]),
    ])
    expect(message).toMatch(/cannot have role owner/)
    await database.query('SELECT chat.create_gugu_group($1,$2,$3,$4::jsonb)', [
      randomUUID(), 'Admin ok', owner, JSON.stringify([{ user_id: friend, role: 'admin' }]),
    ])
  })
})

describe('② join_public_group 尊重入群方式', () => {
  async function tokenOf(group: string) {
    await asService()
    return (await database.query<{ public_id: number; join_token: string }>(
      'SELECT public_id, join_token FROM chat.chats WHERE id = $1', [group])).rows[0]!
  }
  it('approval / invite_only 群拿 token 也直接进不去;open 群照常进', async () => {
    const group = await newGroup({ join_mode: 'approval' })
    const { public_id, join_token } = await tokenOf(group)
    await asUser(outsider)
    expect(await fails('SELECT * FROM chat.join_public_group($1,$2)', [public_id, join_token])).toMatch(/group_join_requires_approval/)
    await asService()
    await database.query("UPDATE chat.chats SET join_mode = 'invite_only' WHERE id = $1", [group])
    await asUser(outsider)
    expect(await fails('SELECT * FROM chat.join_public_group($1,$2)', [public_id, join_token])).toMatch(/group_invite_only/)
    expect(await isMember(group, outsider)).toBe(false)
    await asService()
    await database.query("UPDATE chat.chats SET join_mode = 'open' WHERE id = $1", [group])
    await asUser(outsider)
    await database.query('SELECT * FROM chat.join_public_group($1,$2)', [public_id, join_token])
    expect(await isMember(group, outsider)).toBe(true)
  })
  it('已是成员:无论入群方式都幂等返回', async () => {
    const group = await newGroup({ join_mode: 'invite_only' })
    const { public_id, join_token } = await tokenOf(group)
    await asUser(member)
    const rows = (await database.query<{ is_member: boolean }>('SELECT * FROM chat.join_public_group($1,$2)', [public_id, join_token])).rows
    expect(rows[0]?.is_member).toBe(true)
  })
})

describe('③ provision_taskpage_agent 只往调用者自己所在的群里加', () => {
  async function provision(caller: string, groupChatId: string) {
    await asUser(caller)
    const agentId = randomUUID()
    const newGroupId = randomUUID()
    const row = (await database.query<{ group_chat_id: string; prior_group_state: string; group_created: boolean }>(
      'SELECT * FROM identity.provision_taskpage_agent($1,$2,$3,$4,$5,NULL,$6,$7,$8)',
      [agentId, 'Claude', 'serial', 'claude-code', `dev-${caller}`, groupChatId, newGroupId, 'Project'],
    )).rows[0]!
    return { agentId, newGroupId, row }
  }
  it('递别人的群 id ⇒ agent ❌ 进那个群,改建调用者自己的项目群', async () => {
    const victim = await newGroup()
    const { agentId, newGroupId, row } = await provision(outsider, victim)
    expect(await isMember(victim, agentId)).toBe(false)
    expect(row).toMatchObject({ group_chat_id: newGroupId, prior_group_state: 'foreign', group_created: true })
    expect(await isMember(newGroupId, agentId)).toBe(true)
  })
  it('正对照:自己的项目群 ⇒ 直接加座位;群满 ⇒ 响亮失败', async () => {
    const group = await newGroup()
    const { agentId, row } = await provision(owner, group)
    expect(row).toMatchObject({ group_chat_id: group, prior_group_state: 'active', group_created: false })
    expect(await isMember(group, agentId)).toBe(true)
    await asService()
    await database.query('UPDATE chat.chats SET max_members = 5 WHERE id = $1', [group])
    await asUser(owner)
    expect(await fails(
      'SELECT * FROM identity.provision_taskpage_agent($1,$2,$3,$4,$5,NULL,$6,$7,$8)',
      [randomUUID(), 'Claude', 'serial', 'claude-code', `dev-${owner}`, group, randomUUID(), 'Project'],
    )).toMatch(/member_limit_reached/)
  })
  it('普通成员在「agent 加入需审批」的群里起会话 ⇒ 不绕过审批:进审批队列,这次不入群(20260924074100)', async () => {
    const group = await newGroup({ agent_join_approval: true })
    const { agentId, row } = await provision(member, group)
    expect(row).toMatchObject({ group_chat_id: '', prior_group_state: 'pending_approval', group_created: false })
    expect(await isMember(group, agentId)).toBe(false)
    await asService()
    const queued = (await database.query<{ status: string; requested_by_user_id: string }>(
      'SELECT status, requested_by_user_id FROM chat.group_join_requests WHERE chat_id=$1 AND requester_user_id=$2', [group, agentId])).rows
    expect(queued).toEqual([{ status: 'pending', requested_by_user_id: member }])
  })
})

describe('④ create_topic 不把「需审批」群外的 agent 带进来', () => {
  async function anchor(group: string) {
    const id = randomUUID()
    await asService()
    await database.query(`INSERT INTO chat.messages (id,chat_id,sender_user_id,content,content_type)
      VALUES ($1,$2,$3,'topic anchor','text')`, [id, group, member])
    return id
  }
  it('需审批 ⇒ 拒;关掉审批 ⇒ 放行', async () => {
    const group = await newGroup({ agent_join_approval: true })
    const source = await anchor(group)
    await asUser(member)
    expect(await fails('SELECT * FROM chat.create_topic($1,$2,NULL,NULL,$3)', [group, source, memberAgent]))
      .toMatch(/agent_join_requires_manager/)
    await asService()
    await database.query('UPDATE chat.chats SET agent_join_approval = false WHERE id = $1', [group])
    await asUser(member)
    const topic = (await database.query<{ chat_id: string }>('SELECT * FROM chat.create_topic($1,$2,NULL,NULL,$3)', [group, source, memberAgent])).rows[0]!.chat_id
    expect(await isMember(topic, memberAgent)).toBe(true)
  })
})

describe('⑤ agent 读历史按它自己的可见域', () => {
  async function post(group: string, content: string, createdAt: string) {
    await asService()
    await database.query(`INSERT INTO chat.messages (id,chat_id,sender_user_id,content,content_type,created_at)
      VALUES ($1,$2,$3,$4,'text',$5)`, [randomUUID(), group, owner, content, createdAt])
  }
  it('开了「隐藏聊天记录」:agent 读不到入群前的消息,主人读得到;搜索同理', async () => {
    const group = await newGroup({ hide_history: true })
    await post(group, 'before-join secret', '2020-01-01T00:00:00Z')
    await asService()
    await database.query("INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member')", [group, memberAgent])
    await post(group, 'after-join hello', '2999-01-01T00:00:00Z')

    await asUser(member)
    const agentHistory = (await database.query<{ content: string }>('SELECT content FROM chat.message_history_as($1,$2)', [group, memberAgent])).rows
    expect(agentHistory.map((row) => row.content)).toEqual(['after-join hello'])
    const agentSearch = (await database.query<{ content: string }>('SELECT content FROM chat.message_search_as($1,$2,$3)', [group, 'secret', memberAgent])).rows
    expect(agentSearch).toEqual([])

    // 正对照:主人(建群时就在)两条都读得到 —— 过滤的是 agent 的时间界,不是「这条消息不存在」。
    await asUser(owner)
    const ownerHistory = (await database.query<{ content: string }>('SELECT content FROM chat.message_history_as($1)', [group])).rows
    expect(ownerHistory.map((row) => row.content).sort()).toEqual(['after-join hello', 'before-join secret'])
    const ownerSearch = (await database.query<{ content: string }>('SELECT content FROM chat.message_search_as($1,$2)', [group, 'secret'])).rows
    expect(ownerSearch.map((row) => row.content)).toEqual(['before-join secret'])
  })
  it('只能以自己或自己名下的 agent 身份读', async () => {
    const group = await newGroup()
    await asUser(outsider)
    expect(await fails('SELECT * FROM chat.message_history_as($1,$2)', [group, memberAgent])).toMatch(/Not allowed to act as/)
    expect(await fails('SELECT * FROM chat.message_search_as($1,$2,$3)', [group, 'x', memberAgent])).toMatch(/Not allowed to act as/)
    // 非成员以自己身份读:零行(可见域为空),而不是报错泄露存在性。
    expect((await database.query('SELECT * FROM chat.message_history_as($1)', [group])).rows).toEqual([])
  })
  it('搜索词里的 % 和 _ 按字面匹配', async () => {
    const group = await newGroup()
    await post(group, '100% done', '2999-01-01T00:00:00Z')
    await post(group, '1000 done', '2999-01-01T00:00:01Z')
    await asUser(owner)
    const rows = (await database.query<{ content: string }>('SELECT content FROM chat.message_search_as($1,$2)', [group, '0%'])).rows
    expect(rows.map((row) => row.content)).toEqual(['100% done'])
  })
})

describe('①b 人数上限在并发下不被击穿(两条连接各开一个事务)', () => {
  // 这组要真正的并发:夹具必须提交后另一条连接才看得见,所以不走外层 BEGIN…ROLLBACK,用独立连接、结尾清掉。
  let a: DatabaseClient
  let b: DatabaseClient
  const created: { users: string[]; chats: string[] } = { users: [], chats: [] }

  async function as(client: DatabaseClient, id: string) {
    await client.query('SET LOCAL role TO authenticated')
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
  }
  async function committedHuman(name: string): Promise<string> {
    const id = randomUUID()
    await a.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
    [id, `${id}@gates-3641-race.invalid`])
    await a.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
      ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
    created.users.push(id)
    return id
  }
  /** 已提交的群:owner + admin + member = 3 人,上限 4 ⇒ 只剩一个座位。 */
  async function committedFullMinusOne() {
    const raceOwner = await committedHuman('Race Owner')
    const raceAdmin = await committedHuman('Race Admin')
    const raceMember = await committedHuman('Race Member')
    const id = randomUUID()
    await a.query('BEGIN')
    await as(a, raceOwner)
    await a.query('SELECT chat.create_gugu_group($1,$2,$3,$4::jsonb)', [
      id, 'Race 3641', raceOwner, JSON.stringify([{ user_id: raceMember, role: 'member' }]),
    ])
    await a.query('COMMIT')
    created.chats.push(id)
    await a.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'admin')`, [id, raceAdmin])
    await a.query(`UPDATE chat.chats SET max_members = 4, join_mode = 'open' WHERE id = $1`, [id])
    return { id, raceAdmin }
  }
  async function count(chatId: string) {
    return Number((await a.query<{ n: string }>('SELECT count(*) AS n FROM chat.chat_members WHERE chat_id = $1', [chatId])).rows[0]!.n)
  }
  /** 第二笔必须在第一笔提交前被群行锁挡住 —— 证明是锁在串行化,而不是碰巧先后。 */
  async function expectBlocked(pending: Promise<unknown>) {
    const state = await Promise.race([
      pending.then(() => 'settled', () => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 400)),
    ])
    expect(state).toBe('blocked')
  }

  beforeAll(async () => {
    const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? ''
    a = new Client({ connectionString: url }); b = new Client({ connectionString: url })
    await a.connect(); await b.connect()
  })
  afterAll(async () => {
    try {
      if (created.chats.length) await a.query('DELETE FROM chat.chats WHERE id = ANY($1)', [created.chats])
      if (created.users.length) {
        // 删 auth.users 即走账号注销链路(它自己清 identity 与成员行)。
        await a.query('DELETE FROM auth.users WHERE id = ANY($1::uuid[])', [created.users])
      }
    } finally {
      await a?.end(); await b?.end()
    }
  })

  it('RLS 直插:管理员两条连接各加一个人抢最后一个座位 ⇒ 后一笔等锁、提交后被拒,群不超上限', async () => {
    const { id, raceAdmin } = await committedFullMinusOne()
    const x = await committedHuman('Race X')
    const y = await committedHuman('Race Y')

    await a.query('BEGIN'); await as(a, raceAdmin)
    await a.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member')`, [id, x])
    await b.query('BEGIN'); await as(b, raceAdmin)
    const second = b.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member')`, [id, y])
    await expectBlocked(second)
    await a.query('COMMIT')
    await expect(second).rejects.toThrow(/member_limit_reached/)
    await b.query('ROLLBACK')
    expect(await count(id)).toBe(4)
  })

  it('join_public_group:两个人同时拿链接加入只剩一个座位的群 ⇒ 只进得去一个', async () => {
    const { id } = await committedFullMinusOne()
    const { public_id, join_token } = (await a.query<{ public_id: number; join_token: string }>(
      'SELECT public_id, join_token FROM chat.chats WHERE id = $1', [id])).rows[0]!
    const x = await committedHuman('Joiner X')
    const y = await committedHuman('Joiner Y')

    await a.query('BEGIN'); await as(a, x)
    await a.query('SELECT * FROM chat.join_public_group($1,$2)', [public_id, join_token])
    await b.query('BEGIN'); await as(b, y)
    const second = b.query('SELECT * FROM chat.join_public_group($1,$2)', [public_id, join_token])
    await expectBlocked(second)
    await a.query('COMMIT')
    await expect(second).rejects.toThrow(/Group member limit reached/)
    await b.query('ROLLBACK')
    expect(await count(id)).toBe(4)
  })
})
