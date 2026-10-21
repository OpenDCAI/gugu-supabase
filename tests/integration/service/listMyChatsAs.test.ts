import { createFixtureGroup } from '../../support/groupFixture'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * chat.list_my_chats_as(迁移 20260926005500):p_as_user_id 自己是成员的会话,带它在每个会话里的 role / listen_mode。
 *   · 按 p_as_user_id 自己的成员行判 —— 主人退了群、agent 还在,这个群照样在列
 *     (阴控:同一时刻主人令牌直读 chat_members 看不到这一行,这就是要这条 RPC 的原因);
 *   · 它不在的会话不列;archived 不列,paused / stopped 照列并带 status;
 *   · p_as_user_id 必须过 chat.is_acting_as(本人或调用者名下的 agent)。
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
let strangerAgent: string

interface ChatRow {
  chat_id: string
  public_id: number | null
  kind: string
  status: string
  name: string | null
  role: string
  listen_mode: string | null
  last_message_at: string | null
  last_message_preview: string | null
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
  [id, `${id}@list-my-chats.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'my chats fixture','fixture','darwin')`, [`dev-${id}`, id])
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
async function newGroup(creator: string, name: string, initial: Array<[string, string]>): Promise<string> {
  const id = randomUUID()
  await asUser(creator)
  await createFixtureGroup(database, [
    id, name, creator, JSON.stringify(initial.map(([user_id, role]) => ({ user_id, role }))),
  ])
  await asService()
  return id
}
async function addMember(chatId: string, userId: string, listenMode: string) {
  await asService()
  await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode) VALUES ($1,$2,'member',$3)`,
    [chatId, userId, listenMode])
}
async function listAs(caller: string, actor: string | null) {
  await asUser(caller)
  return await database.query<ChatRow>('SELECT * FROM chat.list_my_chats_as($1)', [actor])
}
function byId(rows: ChatRow[]): Map<string, ChatRow> {
  return new Map(rows.map((row) => [row.chat_id, row]))
}
/** 旧路:主人令牌直读 agent 的成员行(MCP 原来的 message_conversations 就这么读)。 */
async function ownerTokenMemberRows(agent: string): Promise<string[]> {
  await asUser(owner)
  const rows = (await database.query<{ chat_id: string }>('SELECT chat_id FROM chat.chat_members WHERE user_id = $1', [agent])).rows
  return rows.map((row) => row.chat_id)
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('listMyChatsAs.test requires a loopback PostgreSQL database')
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

describe('chat.list_my_chats_as', () => {
  it('按 agent 自己的成员行列,带它的 role 与 listen_mode;它不在的会话不列', async () => {
    const inside = await newGroup(owner, 'Agent inside', [[ownerAgent, 'member']])
    await asService()
    await database.query("UPDATE chat.chat_members SET listen_mode = 'active' WHERE chat_id = $1 AND user_id = $2", [inside, ownerAgent])
    const outside = await newGroup(owner, 'Agent outside', [[stranger, 'member']])

    const chats = byId((await listAs(owner, ownerAgent)).rows)
    expect(chats.get(inside)).toMatchObject({ kind: 'group', status: 'active', name: 'Agent inside', role: 'member', listen_mode: 'active' })
    // 阴性:agent 不在的群不列。正对照:以主人本人问,同一个群在列、role 是 owner。
    expect(chats.has(outside)).toBe(false)
    expect(byId((await listAs(owner, owner)).rows).get(outside)).toMatchObject({ role: 'owner' })
  })

  it('主人退群后 agent 还在:照样在列;同一时刻主人令牌直读看不到这一行', async () => {
    const group = await newGroup(stranger, 'Owner left', [[owner, 'member']])
    await addMember(group, ownerAgent, 'passive')
    // 正对照:主人还在群里时,旧路和新路都看得到。
    expect(await ownerTokenMemberRows(ownerAgent)).toContain(group)
    expect(byId((await listAs(owner, ownerAgent)).rows).has(group)).toBe(true)

    await asService()
    await database.query('DELETE FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2', [group, owner])
    // 前提:agent 没有随主人一起被移出(否则这条 RPC 没有必要)。
    expect((await database.query('SELECT 1 FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2', [group, ownerAgent])).rows).toHaveLength(1)

    expect(await ownerTokenMemberRows(ownerAgent)).not.toContain(group)
    expect(byId((await listAs(owner, ownerAgent)).rows).get(group)).toMatchObject({ name: 'Owner left', role: 'member', listen_mode: 'passive' })
  })

  it('archived 不列;paused / stopped 照列并带 status(正对照:归档前在列)', async () => {
    const paused = await newGroup(owner, 'Paused', [[ownerAgent, 'member']])
    const archived = await newGroup(owner, 'Archived', [[ownerAgent, 'member']])
    await asService()
    await database.query("UPDATE chat.chats SET status = 'paused' WHERE id = $1", [paused])
    expect(byId((await listAs(owner, ownerAgent)).rows).has(archived)).toBe(true)
    await asService()
    await database.query("UPDATE chat.chats SET status = 'archived' WHERE id = $1", [archived])

    const chats = byId((await listAs(owner, ownerAgent)).rows)
    expect(chats.get(paused)).toMatchObject({ status: 'paused' })
    expect(chats.has(archived)).toBe(false)
  })

  it('列名与顺序固定', async () => {
    await newGroup(owner, 'Any', [[ownerAgent, 'member']])
    const result = await listAs(owner, ownerAgent)
    expect(result.fields?.map((field) => field.name)).toEqual([
      'chat_id', 'public_id', 'kind', 'status', 'name', 'role', 'listen_mode', 'last_message_at', 'last_message_preview',
    ])
  })

  it('p_as_user_id 必须是调用者本人或调用者名下的 agent', async () => {
    await newGroup(stranger, 'Stranger group', [[strangerAgent, 'member']])
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.list_my_chats_as($1)', [strangerAgent])).toMatch(/Not allowed to act as/)
    expect(await fails('SELECT * FROM chat.list_my_chats_as($1)', [stranger])).toMatch(/Not allowed to act as/)
    expect(await fails('SELECT * FROM chat.list_my_chats_as($1)', [null])).toMatch(/Not allowed to act as/)
    // 陌生人拿主人的 agent 问 ⇒ 拒(否则就是一个列别人会话的探针)。
    await asUser(stranger)
    expect(await fails('SELECT * FROM chat.list_my_chats_as($1)', [ownerAgent])).toMatch(/Not allowed to act as/)
    // 正对照:陌生人替自己的 agent 问能过。
    expect((await listAs(stranger, strangerAgent)).rows.length).toBeGreaterThan(0)
  })

  it('anon 没有 EXECUTE', async () => {
    await database.query('SET LOCAL role TO anon')
    expect(await fails('SELECT * FROM chat.list_my_chats_as($1)', [ownerAgent])).toMatch(/permission denied/)
  })
})
