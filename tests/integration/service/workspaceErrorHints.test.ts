import { createFixtureGroup } from '../../support/groupFixture'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 群文件夹的拒绝都带 HINT 码(迁移 20261017194409):不是成员 workspace_not_member、没有这个条目 workspace_item_not_found、
 * 没有这一版 workspace_no_version、版本对不上 workspace_version_conflict(DETAIL = 现在的版本号);message 一字不改。
 * 每条用例 BEGIN…ROLLBACK。
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

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asService() {
  await database.query('RESET role')
}
/** The refusal as one line: message | hint | detail. */
async function fails(sql: string, values: unknown[] = []): Promise<string> {
  await database.query('SAVEPOINT expected_failure')
  try {
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT expected_failure')
    const e = error as Error & { hint?: string; detail?: string }
    return `${e.message} | hint: ${e.hint ?? ''} | detail: ${e.detail ?? ''}`
  }
  await database.query('RELEASE SAVEPOINT expected_failure')
  throw new Error(`expected failure, but succeeded: ${sql}`)
}
async function human(name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@workspace-error-hints.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  return id
}
async function newGroup(creator: string, initial: string[]): Promise<string> {
  const id = randomUUID()
  await asUser(creator)
  await createFixtureGroup(database, [
    id, 'Error hints', creator, JSON.stringify(initial.map((user_id) => ({ user_id, role: 'member' }))),
  ])
  await asService()
  return id
}
async function rpc<Row = Record<string, unknown>>(caller: string, sql: string, values: unknown[]): Promise<Row[]> {
  await asUser(caller)
  const { rows } = await database.query<Row>(sql, values)
  await asService()
  return rows
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('workspaceErrorHints.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human('Owner')
  member = await human('Member')
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

describe('拒绝带码,message 照旧', () => {
  it('不是成员、没有这个条目、没有这一版、版本对不上', async () => {
    const group = await newGroup(owner, [member])
    const outsider = await human('Outsider')
    const [doc] = await rpc<{ id: string }>(owner, 'SELECT id FROM chat.workspace_create_document_as($1,$2,$3,$4)', [group, owner, 'a.md', 'x'])
    await asUser(outsider)
    expect(await fails('SELECT * FROM chat.workspace_list_as($1,$2)', [group, outsider]))
      .toBe(`workspace: ${group} is not a chat you are a member of | hint: workspace_not_member | detail: `)
    expect(await fails('SELECT * FROM chat.workspace_get_as($1,$2)', [doc!.id, outsider]))
      .toBe(`workspace item not found: ${doc!.id} | hint: workspace_item_not_found | detail: `)
    expect(await fails('SELECT * FROM chat.workspace_get_as($1,$2)', ['not-a-uuid', outsider]))
      .toBe('workspace item not found: not-a-uuid | hint: workspace_item_not_found | detail: ')
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_version_as($1,$2,$3)', [doc!.id, owner, 9]))
      .toBe(`workspace item ${doc!.id} has no version 9 | hint: workspace_no_version | detail: `)
    expect(await fails('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3,$4)', [doc!.id, owner, 'b.md', 7]))
      .toBe(`workspace item ${doc!.id} version conflict: expected 7, got 1 | hint: workspace_version_conflict | detail: 1`)
    // 对照:版本对得上就过。
    expect((await rpc<{ version: number }>(owner, 'SELECT version FROM chat.workspace_move_as($1,$2,NULL,$3,$4)', [doc!.id, owner, 'b.md', 1]))).toEqual([{ version: 2 }])
  })

  it('换内容版本对不上:DETAIL 是现在的版本号', async () => {
    const group = await newGroup(owner, [member])
    const first = `${group}/${owner}/${randomUUID()}-a.pdf`
    const second = `${group}/${owner}/${randomUUID()}-b.pdf`
    await database.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('workspace',$1),('workspace',$2)`, [first, second])
    const [file] = await rpc<{ id: string }>(owner, 'SELECT id FROM chat.workspace_create_file_as($1,$2,$3,$4,$5,$6)', [group, owner, 'a.pdf', 'application/pdf', 1, first])
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,$4,NULL,$5)', [file!.id, owner, second, 2, 3]))
      .toBe(`workspace item ${file!.id} version conflict: expected 3, got 1 | hint: workspace_version_conflict | detail: 1`)
  })
})
