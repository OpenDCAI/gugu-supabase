import { createFixtureGroup } from '../../support/groupFixture'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * #6492 chat.list_owner_groups_as(迁移 20260925141000):agent 列出「主人所在的群」。
 *   · 只列主人是成员的群:不含话题、不含归档群、不含主人不在的群;
 *   · joined = p_as_user_id 在不在;agent_join_needs_approval = 群开了审批且主人不是群主/管理员;
 *   · 只给入群要用的元数据,❌ 不给预览或正文;
 *   · p_as_user_id 必须是调用者本人或名下的 agent(别人的 agent / 别人 / 空 ⇒ 拒)。替本人问是第 3 件
 *     (20261001094500)放开的:App 的 groups.list() 读的就是它。
 * 每条否定断言配正对照;每条用例 BEGIN…ROLLBACK。
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; fields?: Array<{ name: string }> }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient
let owner: string
let stranger: string
let ownerAgent: string
let otherOwnerAgent: string
let strangerAgent: string

interface GroupRow {
  chat_id: string
  public_id: number
  name: string
  member_count: number
  joined: boolean
  agent_join_needs_approval: boolean
}

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
  [id, `${id}@owner-group-list.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'group list fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}
async function agentOf(ownerId: string, name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, agent_public, device_id)
    VALUES ($1,'agent',$2,$3,true,$4)`, [id, name, ownerId, `dev-${ownerId}`])
  return id
}
/** creator 建群(它是群主),initial 是其余初始成员(至少一个,create_gugu_group 的要求)。 */
async function newGroup(creator: string, name: string, initial: Array<[string, string]>, settings: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await asUser(creator)
  await createFixtureGroup(database, [
    id, name, creator, JSON.stringify(initial.map(([user_id, role]) => ({ user_id, role }))),
  ])
  await asService()
  const keys = Object.keys(settings)
  if (keys.length) {
    await database.query(
      `UPDATE chat.chats SET ${keys.map((key, i) => `${key} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [id, ...keys.map((key) => settings[key])],
    )
  }
  return id
}
async function listAs(caller: string, agent: string | null) {
  await asUser(caller)
  return await database.query<GroupRow>('SELECT * FROM chat.list_owner_groups_as($1)', [agent])
}
function byId(rows: GroupRow[]): Map<string, GroupRow> {
  return new Map(rows.map((row) => [row.chat_id, row]))
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('ownerGroupList6492.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human('Owner')
  stranger = await human('Stranger')
  ownerAgent = await agentOf(owner, 'Owner Agent')
  otherOwnerAgent = await agentOf(owner, 'Second Owner Agent')
  strangerAgent = await agentOf(stranger, 'Stranger Agent')
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

describe('chat.list_owner_groups_as', () => {
  it('只列主人所在的群;joined 按 p_as_user_id 判,人数按成员行数', async () => {
    const withAgent = await newGroup(owner, 'Agent inside', [[ownerAgent, 'member']])
    const withoutAgent = await newGroup(owner, 'Agent outside', [[stranger, 'member']])
    const strangersOnly = await newGroup(stranger, 'Not the owner’s', [[strangerAgent, 'member']])

    const rows = (await listAs(owner, ownerAgent)).rows
    const groups = byId(rows)
    expect(groups.get(withAgent)).toMatchObject({ name: 'Agent inside', member_count: 2, joined: true })
    expect(groups.get(withoutAgent)).toMatchObject({ name: 'Agent outside', member_count: 2, joined: false })
    // 阴性:主人不在的群不列。正对照:同一个群,以它主人的 agent 身份问就列出来。
    expect(groups.has(strangersOnly)).toBe(false)
    expect(byId((await listAs(stranger, strangerAgent)).rows).get(strangersOnly)).toMatchObject({ joined: true })

    // joined 是按 p_as_user_id 算的:换成主人的另一个 agent,同一个群就是 false。
    expect(byId((await listAs(owner, otherOwnerAgent)).rows).get(withAgent)).toMatchObject({ joined: false })
  })

  it('只列 active:stopped / paused 的群不列(正对照:同一个群改回 active 就在列)', async () => {
    const paused = await newGroup(owner, 'Paused', [[stranger, 'member']])
    const stopped = await newGroup(owner, 'Stopped', [[stranger, 'member']])
    await asService()
    await database.query("UPDATE chat.chats SET status = 'paused' WHERE id = $1", [paused])
    await database.query("UPDATE chat.chats SET status = 'stopped' WHERE id = $1", [stopped])
    const hidden = byId((await listAs(owner, ownerAgent)).rows)
    expect(hidden.has(paused)).toBe(false)
    expect(hidden.has(stopped)).toBe(false)
    await asService()
    await database.query("UPDATE chat.chats SET status = 'active' WHERE id = ANY($1::text[])", [[paused, stopped]])
    const shown = byId((await listAs(owner, ownerAgent)).rows)
    expect(shown.has(paused)).toBe(true)
    expect(shown.has(stopped)).toBe(true)
  })

  it('话题与归档群不列(正对照:同一个群归档前在列)', async () => {
    const group = await newGroup(owner, 'Source line', [[stranger, 'member']])
    const anchor = randomUUID()
    await asService()
    await database.query(`INSERT INTO chat.messages (id,chat_id,sender_user_id,content,content_type)
      VALUES ($1,$2,$3,'anchor','text')`, [anchor, group, owner])
    await asUser(owner)
    const topic = (await database.query<{ chat_id: string }>('SELECT * FROM chat.create_topic($1,$2)', [group, anchor])).rows[0]!.chat_id

    const before = byId((await listAs(owner, ownerAgent)).rows)
    expect(before.has(group)).toBe(true)
    expect(before.has(topic)).toBe(false)

    await asService()
    await database.query("UPDATE chat.chats SET status = 'archived' WHERE id = $1", [group])
    expect(byId((await listAs(owner, ownerAgent)).rows).has(group)).toBe(false)
  })

  it('agent_join_needs_approval follows the actual Agent role, not its owner', async () => {
    const asMember = await newGroup(stranger, 'Owner is member', [[owner, 'member']], { agent_join_approval: true })
    const asAdmin = await newGroup(stranger, 'Owner is admin', [[owner, 'admin']], { agent_join_approval: true })
    const asCreator = await newGroup(owner, 'Owner created', [[stranger, 'member']], { agent_join_approval: true })
    const agentAdmin = await newGroup(stranger, 'Agent admin', [[owner, 'member'], [ownerAgent, 'admin']], { agent_join_approval: true })
    const open = await newGroup(stranger, 'No approval', [[owner, 'member']], { agent_join_approval: false })

    const groups = byId((await listAs(owner, ownerAgent)).rows)
    expect(groups.get(asMember)?.agent_join_needs_approval).toBe(true)
    expect(groups.get(asAdmin)?.agent_join_needs_approval).toBe(true)
    expect(groups.get(asCreator)?.agent_join_needs_approval).toBe(true)
    expect(groups.get(open)?.agent_join_needs_approval).toBe(false)
    expect(groups.get(agentAdmin)?.agent_join_needs_approval).toBe(false)
  })

  it('只给入群要用的元数据,不给预览或正文', async () => {
    const group = await newGroup(owner, 'Has a secret', [[stranger, 'member']])
    await asService()
    await database.query(`INSERT INTO chat.messages (id,chat_id,sender_user_id,content,content_type)
      VALUES ($1,$2,$3,'SECRET-6492','text')`, [randomUUID(), group, owner])
    const result = await listAs(owner, ownerAgent)
    expect(result.fields?.map((field) => field.name)).toEqual([
      'chat_id', 'public_id', 'name', 'member_count', 'joined', 'agent_join_needs_approval',
    ])
    expect(JSON.stringify(result.rows)).not.toContain('SECRET-6492')
    // 正对照:这条消息确实在群里(否则「不含正文」是空转)。
    await asService()
    expect((await database.query('SELECT 1 FROM chat.messages WHERE chat_id = $1 AND content = $2', [group, 'SECRET-6492'])).rows).toHaveLength(1)
  })

  it('p_as_user_id 必须是调用者本人或名下的 agent', async () => {
    const group = await newGroup(owner, 'Any group', [[stranger, 'member']])
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.list_owner_groups_as($1)', [strangerAgent])).toMatch(/Not allowed to act as/)
    expect(await fails('SELECT * FROM chat.list_owner_groups_as($1)', [stranger])).toMatch(/Not allowed to act as/)
    expect(await fails('SELECT * FROM chat.list_owner_groups_as($1)', [null])).toMatch(/Not allowed to act as/)
    // 第 3 件:替本人问能过;列出来的都是本人的群,joined 恒为 true。
    expect(byId((await listAs(owner, owner)).rows).get(group)?.joined).toBe(true)
    // 陌生人拿主人的 agent 问 ⇒ 拒(否则就是一个列别人群的探针)。
    await asUser(stranger)
    expect(await fails('SELECT * FROM chat.list_owner_groups_as($1)', [ownerAgent])).toMatch(/Not allowed to act as/)
    // 正对照:主人替自己的 agent 问能过。
    expect((await listAs(owner, ownerAgent)).rows.length).toBeGreaterThan(0)
  })

  it('anon 没有 EXECUTE', async () => {
    await database.query('SET LOCAL role TO anon')
    expect(await fails('SELECT * FROM chat.list_owner_groups_as($1)', [ownerAgent])).toMatch(/permission denied/)
  })
})
