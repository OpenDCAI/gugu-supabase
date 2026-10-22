import { createFixtureGroup } from '../../support/groupFixture'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 第 3 件(迁移 20261001094500):chat.app_enablements 与 workspace_items 的 app_publisher / app_id / last_writer。
 *   · 启用:本群成员读得到群里所有人的行,非成员读不到;只能加、删自己的行;只能加在自己在的群上(外键),
 *     而且只能是群或私聊(20261005114650 起私聊也能;话题跟它所属的群走,不单独启用);人不在群里了,他在这个群的行
 *     由级联带走,别人的不动。
 *   · App 身份的格式:发布者 'gugu' 或一个 user id;id 与 manifest.id 同一条规则。
 *   · 文件的 App:两列同空同不空,改它不动 updated_at(F88);last_writer 的格式。客户端直接写不了(20261017194408)。
 * 每条否定断言配正对照;每条用例 BEGIN…ROLLBACK。
 * 跑法:`GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:<port>/postgres pnpm exec vitest run appEnablementsFileApp`
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient
let owner: string
let carol: string
let stranger: string
let group: string

const VOTE = { publisher: 'gugu', id: 'trip-vote' }

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
  [id, `${id}@app-enablements.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
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
/** 从群里一条消息长出来的话题,members 都是话题成员。 */
async function newTopic(source: string, members: string[]): Promise<string> {
  await asService()
  const message = randomUUID()
  const topic = randomUUID()
  await database.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type) VALUES ($1,$2,$3,'源消息','text')`,
    [message, source, members[0]])
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id, source_chat_id, source_message_id)
    VALUES ($1,'topic','话题',$2,$3,$4)`, [topic, members[0], source, message])
  for (const member of members) {
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING`, [topic, member])
  }
  return topic
}
async function enable(user: string, chat: string, app = VOTE) {
  await asUser(user)
  await database.query('INSERT INTO chat.app_enablements (chat_id, user_id, app_publisher, app_id) VALUES ($1,$2,$3,$4)',
    [chat, user, app.publisher, app.id])
}
async function rowsAsService(chat: string): Promise<Array<{ user_id: string; app_id: string }>> {
  await asService()
  return (await database.query<{ user_id: string; app_id: string }>(
    'SELECT user_id, app_id FROM chat.app_enablements WHERE chat_id = $1 ORDER BY user_id, app_id', [chat])).rows
}
async function document(chat: string, creator: string): Promise<{ id: string; updated_at: string }> {
  await asService()
  return (await database.query<{ id: string; updated_at: string }>(
    `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, inline_text, size_bytes, created_by, created_at, updated_at)
     VALUES ($1,'document','周五去哪.vote.json','application/json','{}',2,$2, now() - interval '1 hour', now() - interval '1 hour')
     RETURNING id, updated_at::text`, [chat, creator])).rows[0]!
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('appEnablementsFileApp.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human('Owner')
  carol = await human('Carol')
  stranger = await human('Stranger')
  group = await newGroup(owner, '出游', [[carol, 'member']])
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

describe('chat.app_enablements', () => {
  it('本群成员读得到群里所有人的启用;非成员读不到', async () => {
    await enable(owner, group)
    await enable(carol, group, { publisher: owner, id: 'menu-board' })
    await asUser(carol)
    expect((await database.query('SELECT 1 FROM chat.app_enablements WHERE chat_id = $1', [group])).rows).toHaveLength(2)
    await asUser(stranger)
    expect((await database.query('SELECT 1 FROM chat.app_enablements WHERE chat_id = $1', [group])).rows).toHaveLength(0)
    // 正对照:两行确实在。
    expect(await rowsAsService(group)).toHaveLength(2)
  })

  it('只能加自己的行;只能加在自己在的群上', async () => {
    await asUser(owner)
    expect(await fails('INSERT INTO chat.app_enablements (chat_id, user_id, app_publisher, app_id) VALUES ($1,$2,$3,$4)',
      [group, carol, VOTE.publisher, VOTE.id])).toMatch(/row-level security/)
    // 不在群里的人:看不见这个群(策略里的 chats 读)或没有成员行(外键),哪一道先拦都是拒。
    await asUser(stranger)
    expect(await fails('INSERT INTO chat.app_enablements (chat_id, user_id, app_publisher, app_id) VALUES ($1,$2,$3,$4)',
      [group, stranger, VOTE.publisher, VOTE.id])).toMatch(/row-level security|foreign key/)
    expect(await rowsAsService(group)).toHaveLength(0)
    // 正对照:群里的人加自己的行能过。
    await enable(carol, group)
    expect(await rowsAsService(group)).toEqual([{ user_id: carol, app_id: VOTE.id }])
  })

  it('话题上不能单独启用:话题跟它所属的群走', async () => {
    const topic = await newTopic(group, [owner, carol])
    await asUser(owner)
    expect(await fails('INSERT INTO chat.app_enablements (chat_id, user_id, app_publisher, app_id) VALUES ($1,$2,$3,$4)',
      [topic, owner, VOTE.publisher, VOTE.id])).toMatch(/row-level security/)
    // 正对照:同一个人、同一个 App,换成群就能过。
    await enable(owner, group)
    expect(await rowsAsService(group)).toEqual([{ user_id: owner, app_id: VOTE.id }])
  })

  // 20261005114650(主人 10-05「私聊也是得有面板的」):私聊不属于任何群,它的 App 就启用在它自己身上。
  it('私聊也能启用:私聊的成员加自己的行能过;私聊外的人加不进去', async () => {
    await asService()
    const dm = randomUUID()
    await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'dm',NULL,$2)`, [dm, owner])
    await database.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member'),($1,$3,'member')`, [dm, owner, carol])
    // 私聊外的人看不见这个私聊:策略里的 chats 读就拦下了(RLS 的 WITH CHECK 先于外键),只会是这一种。
    await asUser(stranger)
    expect(await fails('INSERT INTO chat.app_enablements (chat_id, user_id, app_publisher, app_id) VALUES ($1,$2,$3,$4)',
      [dm, stranger, VOTE.publisher, VOTE.id])).toMatch(/row-level security/)
    // 正对照:私聊里的人加自己的行能过,两个人各一行。
    await enable(owner, dm)
    await enable(carol, dm)
    const rows = await rowsAsService(dm)
    expect(rows.map((row) => row.user_id).sort()).toEqual([owner, carol].sort())
    expect(rows.every((row) => row.app_id === VOTE.id)).toBe(true)
  })

  it('不存在的对话上启用:同样是策略拦下', async () => {
    const nowhere = randomUUID()
    await asUser(owner)
    expect(await fails('INSERT INTO chat.app_enablements (chat_id, user_id, app_publisher, app_id) VALUES ($1,$2,$3,$4)',
      [nowhere, owner, VOTE.publisher, VOTE.id])).toMatch(/row-level security/)
    expect(await rowsAsService(nowhere)).toHaveLength(0)
  })

  it('只能删自己的行', async () => {
    await enable(owner, group)
    await asUser(carol)
    expect((await database.query('DELETE FROM chat.app_enablements WHERE chat_id = $1 AND user_id = $2', [group, owner])).rowCount).toBe(0)
    expect(await rowsAsService(group)).toHaveLength(1)
    // 正对照:本人删得掉。
    await asUser(owner)
    expect((await database.query('DELETE FROM chat.app_enablements WHERE chat_id = $1 AND user_id = $2', [group, owner])).rowCount).toBe(1)
    expect(await rowsAsService(group)).toHaveLength(0)
  })

  it('人退群,他在这个群的启用由级联带走;别人的不动', async () => {
    // Existing roster fixture; Carol leaves through the shared product door.
    const dave = await human('Dave')
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`, [group, dave])
    await enable(owner, group)
    await enable(carol, group)
    await asUser(carol)
    expect((await database.query('SELECT chat.remove_group_member_as($1,$2,auth.uid()::text)', [group, carol])).rowCount).toBe(1)
    expect(await rowsAsService(group)).toEqual([{ user_id: owner, app_id: VOTE.id }])
  })

  it('App 身份的格式:发布者是 gugu 或一个 user id,id 与 manifest.id 同一条规则', async () => {
    await asUser(owner)
    expect(await fails('INSERT INTO chat.app_enablements (chat_id, user_id, app_publisher, app_id) VALUES ($1,$2,$3,$4)',
      [group, owner, 'someone', VOTE.id])).toMatch(/app_enablements_publisher_chk/)
    expect(await fails('INSERT INTO chat.app_enablements (chat_id, user_id, app_publisher, app_id) VALUES ($1,$2,$3,$4)',
      [group, owner, owner, 'Trip.Vote'])).toMatch(/app_enablements_app_id_chk/)
    // 正对照:一个人发布的、合规的 id 能过。
    await enable(owner, group, { publisher: carol, id: 'trip-vote' })
    expect(await rowsAsService(group)).toHaveLength(1)
  })

  it('anon 什么都碰不到;authenticated 没有 UPDATE(启用只有加和删)', async () => {
    await asService()
    const privileges = (await database.query<{ anon: boolean; update: boolean; insert: boolean }>(`SELECT
      has_table_privilege('anon', 'chat.app_enablements', 'SELECT') AS anon,
      has_table_privilege('authenticated', 'chat.app_enablements', 'UPDATE') AS update,
      has_table_privilege('authenticated', 'chat.app_enablements', 'INSERT') AS insert`)).rows[0]!
    expect(privileges).toEqual({ anon: false, update: false, insert: true })
  })
})

describe('chat.workspace_items 的 App 与 last_writer', () => {
  it('客户端直接写不了这三列(20261017194408 起表只经 *_as 写):建、改都拒,成员也一样', async () => {
    await asUser(carol)
    expect(await fails(
      `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, inline_text, size_bytes, created_by, app_publisher, app_id)
       VALUES ($1,'document','x.vote.json','application/json','{}',2,$2,$3,$4)`,
      [group, carol, VOTE.publisher, VOTE.id])).toMatch(/permission denied/)
    const file = await document(group, owner)
    await asUser(carol)
    expect(await fails('UPDATE chat.workspace_items SET app_publisher = $2, app_id = $3 WHERE id = $1', [file.id, VOTE.publisher, VOTE.id]))
      .toMatch(/permission denied/)
    await asUser(carol)
    expect(await fails('UPDATE chat.workspace_items SET last_writer = $2 WHERE id = $1', [file.id, 'gugu/trip-vote@1.0.0'])).toMatch(/permission denied/)
  })

  it('带着 app_* 与 last_writer 一条插入建成;设 App 不动 updated_at(F88);「不再固定」两列一起清空', async () => {
    await asService()
    const inserted = (await database.query<{ app_publisher: string; app_id: string; last_writer: string }>(
      `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, inline_text, size_bytes, source_message_ids, created_by, version,
         app_publisher, app_id, last_writer)
       VALUES ($1,'document','周六.vote.json','application/json','{}',2,'{}',$2,1,$3,$4,$5)
       RETURNING app_publisher, app_id, last_writer`,
      [group, carol, VOTE.publisher, VOTE.id, 'gugu/trip-vote@1.0.0'])).rows[0]!
    expect(inserted).toEqual({ app_publisher: VOTE.publisher, app_id: VOTE.id, last_writer: 'gugu/trip-vote@1.0.0' })
    const file = await document(group, owner)
    await asService()
    expect((await database.query('UPDATE chat.workspace_items SET app_publisher = $2, app_id = $3 WHERE id = $1',
      [file.id, VOTE.publisher, VOTE.id])).rowCount).toBe(1)
    const after = (await database.query<{ app_publisher: string; app_id: string; updated_at: string }>(
      'SELECT app_publisher, app_id, updated_at::text FROM chat.workspace_items WHERE id = $1', [file.id])).rows[0]!
    expect(after).toEqual({ app_publisher: VOTE.publisher, app_id: VOTE.id, updated_at: file.updated_at })
    expect((await database.query('UPDATE chat.workspace_items SET app_publisher = NULL, app_id = NULL WHERE id = $1', [file.id])).rowCount).toBe(1)
  })

  it('两列同空同不空;身份格式与启用表同一条', async () => {
    const file = await document(group, owner)
    await asService()
    expect(await fails('UPDATE chat.workspace_items SET app_id = $2 WHERE id = $1', [file.id, VOTE.id])).toMatch(/workspace_items_app_chk/)
    expect(await fails('UPDATE chat.workspace_items SET app_publisher = $2, app_id = $3 WHERE id = $1',
      [file.id, 'someone', VOTE.id])).toMatch(/workspace_items_app_chk/)
    // 正对照:一对合规的值能写。
    expect((await database.query('UPDATE chat.workspace_items SET app_publisher = $2, app_id = $3 WHERE id = $1',
      [file.id, owner, VOTE.id])).rowCount).toBe(1)
  })

  it('last_writer 是 <发布者>/<id>@<x.y.z>', async () => {
    const file = await document(group, owner)
    await asService()
    expect(await fails('UPDATE chat.workspace_items SET last_writer = $2 WHERE id = $1', [file.id, 'trip-vote@1.0.0']))
      .toMatch(/workspace_items_last_writer_chk/)
    expect(await fails('UPDATE chat.workspace_items SET last_writer = $2 WHERE id = $1', [file.id, `${owner}/trip-vote@1.0`]))
      .toMatch(/workspace_items_last_writer_chk/)
    // 正对照。
    expect((await database.query('UPDATE chat.workspace_items SET last_writer = $2 WHERE id = $1', [file.id, `${owner}/trip-vote@1.2.0`])).rowCount).toBe(1)
    expect((await database.query('UPDATE chat.workspace_items SET last_writer = $2 WHERE id = $1', [file.id, 'gugu/workspace@0.3.1'])).rowCount).toBe(1)
  })
})
