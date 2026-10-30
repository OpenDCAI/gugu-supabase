import { createFixtureGroup } from '../../support/groupFixture'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 群文件的最近打开与跨对话搜索(迁移 20261017024605;gugu-base notes/2026-10-17-office-recent-search):
 *   · workspace_note_open 只记本人，只记他打得开的文件(打不开的和不存在的答同一句);同一个文件再打开一次就挪到最前，
 *     还是一行;文件删掉，记录跟着删;
 *   · workspace_recent / workspace_search 从「谁在问」所在的对话出发：人退出了群，那里的文件就不再出现;代自己名下的 agent
 *     查时，只看得到 agent 所在的对话;代别人的 agent 查会被拒;
 *   · 搜索按路径匹配(不分大小写，%/_ 按字面),后缀过滤不分大小写，文件夹本身不出现;
 *   · 打开记录表客户端不能直接读写。
 * 每条否定配一个正对照;每条用例 BEGIN…ROLLBACK。
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient
let owner: string
let member: string
let outsider: string
let agent: string
/** In every group made here: a group has at least two members, and stays so when someone leaves. */
let bystander: string

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asService() {
  await database.query('RESET role')
}
async function fails(sql: string, values: unknown[] = []): Promise<string> {
  await database.query('SAVEPOINT expected_failure')
  try {
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT expected_failure')
    return (error as Error).message
  }
  await database.query('RELEASE SAVEPOINT expected_failure')
  throw new Error(`expected failure, but succeeded: ${sql}`)
}
async function human(name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@workspace-recent.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'recent fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}
async function agentOf(ownerId: string, name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, agent_public, device_id)
    VALUES ($1,'agent',$2,$3,true,$4)`, [id, name, ownerId, `dev-${ownerId}`])
  return id
}
async function newGroup(creator: string, name: string, initial: string[]): Promise<string> {
  const id = randomUUID()
  await asUser(creator)
  await createFixtureGroup(database, [
    id, name, creator, JSON.stringify([...initial, bystander].map((user_id) => ({ user_id, role: 'member' }))),
  ])
  await asService()
  return id
}
async function put(chatId: string, by: string, filename: string, opts: { kind?: 'document' | 'folder'; parent?: string | null } = {}): Promise<string> {
  await asService()
  const kind = opts.kind ?? 'document'
  const { rows } = await database.query<{ id: string }>(
    `INSERT INTO chat.workspace_items (chat_id, parent_id, kind, filename, content_type, inline_text, size_bytes, source_message_ids, created_by, version)
     VALUES ($1,$2,$3,$4,$5,$6,0,'{}',$7,1) RETURNING id`,
    [chatId, opts.parent ?? null, kind, filename, kind === 'folder' ? 'inode/directory' : 'text/plain', kind === 'folder' ? null : '', by],
  )
  await asService()
  return rows[0]!.id
}
async function opened(caller: string, itemId: string) {
  await asUser(caller)
  await database.query('SELECT chat.workspace_note_open($1)', [itemId])
  await asService()
}
async function recent(caller: string, asUserId: string | null = null): Promise<{ filename: string; path: string; chat_name: string }[]> {
  await asUser(caller)
  const { rows } = await database.query<{ filename: string; path: string; chat_name: string }>(
    'SELECT filename, path, chat_name FROM chat.workspace_recent(p_as_user_id => $1)', [asUserId])
  await asService()
  return rows
}
async function search(caller: string, args: { query?: string | null; suffixes?: string[] | null; asUserId?: string | null } = {}): Promise<string[]> {
  await asUser(caller)
  const { rows } = await database.query<{ path: string; chat_name: string }>(
    'SELECT path, chat_name FROM chat.workspace_search(p_query => $1, p_suffixes => $2, p_as_user_id => $3)',
    [args.query ?? null, args.suffixes ?? null, args.asUserId ?? null])
  await asService()
  return rows.map((row) => `${row.chat_name}:${row.path}`).sort()
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('workspaceRecentSearch.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })

describe('within one transaction', () => {
  beforeEach(async () => {
    await database.query('BEGIN')
    owner = await human('Owner')
    member = await human('Member')
    outsider = await human('Outsider')
    agent = await agentOf(owner, 'Owner Agent')
    bystander = await human('Bystander')
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

  it('最近：新打开的在前;再打开一次挪到最前，还是一行;只有本人的', async () => {
    const a = await newGroup(owner, 'Alpha', [member])
    const b = await newGroup(owner, 'Beta', [])
    const deck = await put(a, owner, 'deck.pptx')
    const notes = await put(b, owner, 'notes.md')
    await opened(owner, deck)
    await opened(owner, notes)
    expect(await recent(owner)).toEqual([
      { filename: 'notes.md', path: 'notes.md', chat_name: 'Beta' },
      { filename: 'deck.pptx', path: 'deck.pptx', chat_name: 'Alpha' },
    ])
    await opened(owner, deck)
    expect((await recent(owner)).map((row) => row.filename)).toEqual(['deck.pptx', 'notes.md'])
    // 别人打开的不进我的最近;他自己的最近里有(正对照)。
    await opened(member, deck)
    expect((await recent(member)).map((row) => row.filename)).toEqual(['deck.pptx'])
    expect(await recent(owner)).toHaveLength(2)
    await asService()
    const { rows } = await database.query<{ n: string }>('SELECT count(*) AS n FROM chat.workspace_item_opens WHERE user_id = $1', [owner])
    expect(rows[0]!.n).toBe('2')
  })

  it('打不开的文件记不了，和不存在的答同一句;文件夹不记', async () => {
    const a = await newGroup(owner, 'Alpha', [])
    const deck = await put(a, owner, 'deck.pptx')
    const folder = await put(a, owner, 'Docs', { kind: 'folder' })
    await asUser(outsider)
    const notMine = await fails('SELECT chat.workspace_note_open($1)', [deck])
    const nowhere = await fails('SELECT chat.workspace_note_open($1)', [randomUUID()])
    expect(notMine.replace(deck, '<id>')).toBe(nowhere.replace(/[0-9a-f-]{36}/, '<id>'))
    await asUser(owner)
    expect(await fails('SELECT chat.workspace_note_open($1)', [folder])).toMatch(/is a folder/)
    await asService()
    await opened(owner, deck)
    expect((await recent(owner)).map((row) => row.filename)).toEqual(['deck.pptx'])
  })

  it('退出了群，那里的文件不再出现在最近和搜索里;文件删掉，记录跟着删', async () => {
    const a = await newGroup(owner, 'Alpha', [member])
    const deck = await put(a, owner, 'deck.pptx')
    await opened(member, deck)
    expect((await recent(member)).map((row) => row.filename)).toEqual(['deck.pptx'])
    expect(await search(member, { query: 'deck' })).toEqual(['Alpha:deck.pptx'])
    await asService()
    await database.query('DELETE FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2', [a, member])
    expect(await recent(member)).toEqual([])
    expect(await search(member, { query: 'deck' })).toEqual([])

    await opened(owner, deck)
    await asService()
    await database.query('DELETE FROM chat.workspace_items WHERE id = $1', [deck])
    const { rows } = await database.query('SELECT 1 FROM chat.workspace_item_opens WHERE item_id = $1', [deck])
    expect(rows).toEqual([])
  })

  it('搜索：跨我所在的对话，按路径匹配;不在的群里同名的不出现', async () => {
    const a = await newGroup(owner, 'Alpha', [])
    const b = await newGroup(owner, 'Beta', [member])
    const theirs = await newGroup(outsider, 'Theirs', [])
    const docs = await put(a, owner, 'Docs', { kind: 'folder' })
    await put(a, owner, 'Report 2026.md', { parent: docs })
    await put(b, member, 'report.xlsx')
    await put(b, member, 'other.pptx')
    await put(theirs, outsider, 'report.md')

    expect(await search(owner, { query: 'REPORT' })).toEqual(['Alpha:Docs/Report 2026.md', 'Beta:report.xlsx'])
    expect(await search(owner, { query: 'docs/rep' })).toEqual(['Alpha:Docs/Report 2026.md'])
    // 正对照：外人自己群里的那份，他自己搜得到。
    expect(await search(outsider, { query: 'report' })).toEqual(['Theirs:report.md'])
    // 文件夹本身不出现;不带查询 = 全部文件。
    expect(await search(owner)).toEqual(['Alpha:Docs/Report 2026.md', 'Beta:other.pptx', 'Beta:report.xlsx'])
    // %、_ 按字面。
    expect(await search(owner, { query: '%' })).toEqual([])
    expect(await search(owner, { query: 'report_' })).toEqual([])
  })

  it('搜索：后缀过滤不分大小写', async () => {
    const a = await newGroup(owner, 'Alpha', [])
    await put(a, owner, 'a.MD')
    await put(a, owner, 'b.pptx')
    await put(a, owner, 'c.json')
    expect(await search(owner, { suffixes: ['.md', '.PPTX'] })).toEqual(['Alpha:a.MD', 'Alpha:b.pptx'])
  })

  it('代自己名下的 agent 查：只看得到 agent 所在的对话;最近仍是本人的打开，只剩 agent 那几个群的', async () => {
    const withAgent = await newGroup(owner, 'WithAgent', [agent])
    const without = await newGroup(owner, 'Without', [])
    const seen = await put(withAgent, owner, 'seen.md')
    const hidden = await put(without, owner, 'hidden.md')
    await opened(owner, seen)
    await opened(owner, hidden)

    expect(await search(owner, { query: '.md' })).toEqual(['WithAgent:seen.md', 'Without:hidden.md'])
    expect(await search(owner, { query: '.md', asUserId: agent })).toEqual(['WithAgent:seen.md'])
    // This case checks visibility; the dedicated recent-order case above checks ordering.
    expect((await recent(owner)).map((row) => row.filename).sort()).toEqual(['hidden.md', 'seen.md'])
    expect((await recent(owner, agent)).map((row) => row.filename)).toEqual(['seen.md'])

    // 代别人的 agent、代别人，都被拒。
    const theirAgent = await agentOf(outsider, 'Their Agent')
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_search(p_as_user_id => $1)', [theirAgent])).toMatch(/Not allowed to act as/)
    expect(await fails('SELECT * FROM chat.workspace_recent(p_as_user_id => $1)', [member])).toMatch(/Not allowed to act as/)
  })

  it('打开记录表客户端读不到也写不了;内部函数调不到;limit 越界报错', async () => {
    const a = await newGroup(owner, 'Alpha', [])
    const deck = await put(a, owner, 'deck.pptx')
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_item_opens')).toMatch(/permission denied/)
    expect(await fails('INSERT INTO chat.workspace_item_opens (user_id, item_id) VALUES ($1, $2)', [owner, deck])).toMatch(/permission denied/)
    expect(await fails('SELECT * FROM chat.workspace_placed_for($1)', [owner])).toMatch(/permission denied/)
    expect(await fails('SELECT * FROM chat.workspace_search(p_limit => 0)')).toMatch(/limit must be 1 to 200/)
    expect(await fails('SELECT * FROM chat.workspace_recent(p_limit => 201)')).toMatch(/limit must be 1 to 200/)
    // 未登录的 anon:表和三个函数都碰不到。
    await database.query('SET LOCAL role TO anon')
    expect(await fails('SELECT * FROM chat.workspace_item_opens')).toMatch(/permission denied/)
    expect(await fails('SELECT chat.workspace_note_open($1)', [deck])).toMatch(/permission denied/)
    expect(await fails('SELECT * FROM chat.workspace_recent()')).toMatch(/permission denied/)
    expect(await fails('SELECT * FROM chat.workspace_search()')).toMatch(/permission denied/)
    await asUser(owner)
    // 正对照：经函数记得上、读得到。
    await database.query('SELECT chat.workspace_note_open($1)', [deck])
    const { rows } = await database.query<{ filename: string }>('SELECT filename FROM chat.workspace_recent(p_limit => 200)')
    expect(rows.map((row) => row.filename)).toEqual(['deck.pptx'])
  })
})
