import { createFixtureGroup } from '../../support/groupFixture'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * #6492 第 3 刀(迁移 20260925141100):agent 读写群工作区按 agent 自己的成员身份判。
 *   · 主人在、agent 不在的群:status / list / get 一律拒;agent 入群后同一批读能读到(正对照);
 *   · 写入的 created_by 是 agent 自己;文档的乐观并发、空标题、文件 pointer 首段必须是本房间;
 *   · 删除:agent 自己建的、或它主人建的可删,别人建的不可删;
 *   · 提问资格走 chat.is_acting_as:别人的 agent 拒;私聊不是工作区。
 * 每条否定断言配正对照;每条用例 BEGIN…ROLLBACK。
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient
let owner: string
let stranger: string
let agent: string
let strangerAgent: string

interface Item { id: string; chat_id: string; kind: string; filename: string; created_by: string; version: number; size_bytes: string; pointer: string | null; inline_text: string | null }

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
  [id, `${id}@workspace-scope.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'workspace fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}
async function agentOf(ownerId: string, name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, agent_public, device_id)
    VALUES ($1,'agent',$2,$3,true,$4)`, [id, name, ownerId, `dev-${ownerId}`])
  return id
}
async function newGroup(creator: string, initial: string[]): Promise<string> {
  const id = randomUUID()
  await asUser(creator)
  await createFixtureGroup(database, [
    id, 'Workspace room', creator, JSON.stringify(initial.map((user_id) => ({ user_id, role: 'member' }))),
  ])
  await asService()
  return id
}
async function join(chatId: string, userId: string) {
  await asService()
  await database.query("INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member')", [chatId, userId])
}
/** 一篇 created_by = by 的文档(服务端直接插)—— 本刀之前 agent 写入的行就是这个形态(created_by = 主人)。 */
async function ownerDocument(chatId: string, title: string, by = owner): Promise<string> {
  await asService()
  const { rows } = await database.query<{ id: string }>(
    `INSERT INTO chat.workspace_items (chat_id, kind, filename, inline_text, created_by) VALUES ($1,'document',$2,'body',$3) RETURNING id`,
    [chatId, title, by],
  )
  await asService()
  return rows[0]!.id
}
async function call<Row = Item>(sql: string, values: unknown[]): Promise<Row[]> {
  await asUser(owner)
  return (await database.query<Row>(sql, values)).rows
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('workspaceAgentScope6492.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human('Owner')
  stranger = await human('Stranger')
  agent = await agentOf(owner, 'Owner Agent')
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

describe('workspace *_as:只看 agent 自己是不是成员', () => {
  it('主人在、agent 不在 ⇒ status / list / get 都拒;agent 入群后同一批读能读到', async () => {
    const group = await newGroup(owner, [stranger])
    const doc = await ownerDocument(group, 'Owner notes')
    // 数据确实在,主人按表 RLS 读得到(否则「agent 读不到」是空转)。
    await asUser(owner)
    expect((await database.query('SELECT id FROM chat.workspace_items WHERE chat_id = $1', [group])).rows).toHaveLength(1)

    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_status_as($1,$2)', [group, agent])).toMatch(/not a chat you are a member of/)
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_list_as($1,$2)', [group, agent])).toMatch(/not a chat you are a member of/)
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_get_as($1,$2)', [doc, agent])).toMatch(/workspace item not found/)

    await join(group, agent)
    expect(await call('SELECT * FROM chat.workspace_status_as($1,$2)', [group, agent])).toEqual([{ total: 1, documents: 1, files: 0 }])
    expect((await call('SELECT * FROM chat.workspace_list_as($1,$2)', [group, agent])).map((row) => row.id)).toEqual([doc])
    expect((await call('SELECT * FROM chat.workspace_get_as($1,$2)', [doc, agent]))[0]).toMatchObject({ id: doc, inline_text: 'body' })
  })

  // 20261005114650(主人 10-05「私聊也是得有面板的」):私聊也有自己的工作区,和群、话题同一种 —— 看的仍只是 agent 自己是不是成员。
  it('私聊也是工作区:agent 在这个私聊里就能读写;不在的私聊、不存在的对话同一句话', async () => {
    await asService()
    const dm = randomUUID()
    await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'dm',NULL,$2)`, [dm, owner])
    await database.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member'),($1,$3,'member')`, [dm, owner, agent])
    expect(await call('SELECT * FROM chat.workspace_status_as($1,$2)', [dm, agent])).toEqual([{ total: 0, documents: 0, files: 0 }])
    const [row] = await call('SELECT * FROM chat.workspace_create_document_as($1,$2,$3,$4,NULL,NULL)', [dm, agent, '存档', '{}'])
    expect(row).toMatchObject({ kind: 'document', filename: '存档', created_by: agent })
    expect((await call('SELECT * FROM chat.workspace_list_as($1,$2)', [dm, agent])).map((item) => item.id)).toEqual([row!.id])
    expect((await call('SELECT * FROM chat.workspace_get_as($1,$2)', [row!.id, agent]))[0]).toMatchObject({ inline_text: '{}' })

    // 主人和别人的私聊:agent 不是成员 ⇒ 拒,和群里一样。
    await asService()
    const theirs = randomUUID()
    await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'dm',NULL,$2)`, [theirs, owner])
    await database.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member'),($1,$3,'member')`, [theirs, owner, stranger])
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_status_as($1,$2)', [theirs, agent])).toMatch(/not a chat you are a member of/)
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_status_as($1,$2)', [randomUUID(), agent])).toMatch(/not a chat you are a member of/)
  })

  it('提问资格:别人的 agent 拒,陌生人拿主人的 agent 也拒;anon 没有 EXECUTE', async () => {
    const group = await newGroup(owner, [agent])
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_status_as($1,$2)', [group, strangerAgent])).toMatch(/Not allowed to act as/)
    await asUser(stranger)
    expect(await fails('SELECT * FROM chat.workspace_status_as($1,$2)', [group, agent])).toMatch(/Not allowed to act as/)
    await database.query('SET LOCAL role TO anon')
    expect(await fails('SELECT * FROM chat.workspace_status_as($1,$2)', [group, agent])).toMatch(/permission denied/)
    // 正对照:主人替自己的 agent 问能过。
    expect(await call('SELECT * FROM chat.workspace_status_as($1,$2)', [group, agent])).toEqual([{ total: 0, documents: 0, files: 0 }])
  })
})

describe('workspace *_as:写', () => {
  it('建文档:created_by 是 agent,size 按字节;空标题拒;不在的群拒', async () => {
    const group = await newGroup(owner, [agent])
    const [row] = await call('SELECT * FROM chat.workspace_create_document_as($1,$2,$3,$4,NULL,NULL)', [group, agent, 'Plan', '你好'])
    expect(row).toMatchObject({ kind: 'document', filename: 'Plan', created_by: agent, version: 1 })
    expect(Number(row!.size_bytes)).toBe(6) // int8 comes back as a string from pg
    // 20260929064500:写的返回只有元数据(不带正文,也不带协同状态);正文按 get_as 读回核对。
    expect(row).not.toHaveProperty('inline_text')
    expect((await call('SELECT * FROM chat.workspace_get_as($1,$2)', [row!.id, agent]))[0]).toMatchObject({ inline_text: '你好' })
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_create_document_as($1,$2,$3,$4,NULL,NULL)', [group, agent, '  ', 'x'])).toMatch(/title is required/)
    const outside = await newGroup(owner, [stranger])
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_create_document_as($1,$2,$3,$4,NULL,NULL)', [outside, agent, 'Plan', 'x'])).toMatch(/not a chat you are a member of/)
  })

  it('改名 = 原地 workspace_move_as:版本冲突拒、成功 version+1、正文不动;空名拒', async () => {
    const group = await newGroup(owner, [agent])
    const [doc] = await call('SELECT * FROM chat.workspace_create_document_as($1,$2,$3,$4,NULL,NULL)', [group, agent, 'Plan', 'v1'])
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3,$4)', [doc!.id, agent, 'Plan v2', 7])).toMatch(/version conflict: expected 7, got 1/)
    const [updated] = await call('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3,$4)', [doc!.id, agent, 'Plan v2', 1])
    expect(updated).toMatchObject({ version: 2, filename: 'Plan v2' })
    expect(updated).not.toHaveProperty('inline_text')
    expect((await call('SELECT * FROM chat.workspace_get_as($1,$2)', [doc!.id, agent]))[0]).toMatchObject({ inline_text: 'v1' })
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3)', [doc!.id, agent, ' '])).toMatch(/名字不能是空的/)
  })

  it('登记文件:pointer 首段必须是本房间(正对照:本房间的对象登记成功,created_by 是 agent)', async () => {
    const group = await newGroup(owner, [agent])
    const other = await newGroup(owner, [agent])
    const mine = `${group}/${owner}/${randomUUID()}-a.txt`
    const foreign = `${other}/${owner}/${randomUUID()}-b.txt`
    await asService()
    await database.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('workspace',$1),('workspace',$2)`, [mine, foreign])
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_create_file_as($1,$2,$3,$4,$5,$6,NULL)', [group, agent, 'b.txt', 'text/plain', 1, foreign]))
      .toMatch(/pointer must live under/)
    const [row] = await call('SELECT * FROM chat.workspace_create_file_as($1,$2,$3,$4,$5,$6,NULL)', [group, agent, 'a.txt', 'text/plain', 1, mine])
    expect(row).toMatchObject({ kind: 'file', pointer: mine, created_by: agent })
    const [file] = await call('SELECT * FROM chat.workspace_get_as($1,$2)', [row!.id, agent])
    // 改名(原地 move)对文件也成立(MCP 的 workspace_rename);pointer 不动。
    const [renamed] = await call('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3)', [file!.id, agent, 'final.txt'])
    expect(renamed).toMatchObject({ id: file!.id, filename: 'final.txt', pointer: mine })
  })

  it('删:自己建的、主人建的可删;别人建的不可删', async () => {
    const group = await newGroup(owner, [agent, stranger])
    const [own] = await call('SELECT * FROM chat.workspace_create_document_as($1,$2,$3,$4,NULL,NULL)', [group, agent, 'Mine', 'x'])
    const ownerMade = await ownerDocument(group, 'Owner made')
    const strangerMade = await ownerDocument(group, 'Stranger made', stranger)
    expect((await call('SELECT * FROM chat.workspace_delete_as($1,$2)', [own!.id, agent])).map((row) => row.id)).toEqual([own!.id])
    expect((await call('SELECT * FROM chat.workspace_delete_as($1,$2)', [ownerMade, agent])).map((row) => row.id)).toEqual([ownerMade])
    await asUser(owner)
    // 说人话(gugu-supabase 20261016012659,复核 L11 追记 3);码在 HINT workspace_item_not_yours。
    expect(await fails('SELECT * FROM chat.workspace_delete_as($1,$2)', [strangerMade, agent])).toBe('「Stranger made」不是你(或你的 agent)建的,删不了')
    await asService()
    expect((await database.query('SELECT id FROM chat.workspace_items WHERE chat_id = $1', [group])).rows.map((row) => row.id)).toEqual([strangerMade])
  })

  it('人以自己的身份走同一扇门:主人能删自己 agent 建的文档,别的成员删不掉', async () => {
    const group = await newGroup(owner, [agent, stranger])
    const [byAgent] = await call('SELECT * FROM chat.workspace_create_document_as($1,$2,$3,$4,NULL,NULL)', [group, agent, 'Agent made', 'x'])
    // 阴控:别的成员(不是创建者,也不是创建者的主人)删不掉。
    await asUser(stranger)
    expect(await fails('SELECT * FROM chat.workspace_delete_as($1,$2)', [byAgent!.id, stranger])).toMatch(/不是你\(或你的 agent\)建的/)
    // 正对照:主人删得掉(created_by 是他名下的 agent)。
    expect((await call('SELECT id FROM chat.workspace_delete_as($1,$2)', [byAgent!.id, owner])).map((row) => row.id)).toEqual([byAgent!.id])
  })
})
