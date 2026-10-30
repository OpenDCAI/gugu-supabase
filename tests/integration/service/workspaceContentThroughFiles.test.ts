import { createFixtureGroup } from '../../support/groupFixture'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 工作区正文只剩文件服务一条写入路(迁移 20261006110100,真源 gugu-base notes/2026-09-29-app-platform/workspace-app §3 第 2 步):
 *   · authenticated 不能再直接改 inline_text / size_bytes(20261017194408 起表一列都不能直接写);改名、删除走 *_as;
 *     文件服务照写。
 *   · workspace_update_document_as 在 20261017194408 删了(改名 = 原地 workspace_move_as)。
 * 旧写法是 ≤ v0.2.50 客户端的:旧编辑器 `.from('workspace_items').update({ inline_text, size_bytes, … })`。
 * 每条否定配正对照;每条用例 BEGIN…ROLLBACK。
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
/** 文件服务的连接:没有 JWT,只有 gugu_files 自己的授权。 */
async function asFiles() {
  await database.query('RESET role')
  await database.query("SELECT set_config('request.jwt.claims', '', true)")
  await database.query('SET LOCAL role TO gugu_files')
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
  [id, `${id}@workspace-content-files.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'content-through-files fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}
async function newGroup(creator: string, initial: string[]): Promise<string> {
  const id = randomUUID()
  await asUser(creator)
  await createFixtureGroup(database, [
    id, 'Content through files', creator, JSON.stringify(initial.map((user_id) => ({ user_id, role: 'member' }))),
  ])
  await asService()
  return id
}
/** 一个文本文件,带初始正文(服务端直接插,created_by = by)。 */
async function document(chatId: string, by: string): Promise<string> {
  await asService()
  const { rows } = await database.query<{ id: string }>(
    `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, inline_text, size_bytes, source_message_ids, created_by, version)
     VALUES ($1,'document','notes.md','text/markdown','body',4,'{}',$2,1) RETURNING id`,
    [chatId, by],
  )
  await asService()
  return rows[0]!.id
}
/** 一个二进制文件:对象进桶以后 INSERT 一条 pointer(服务端直接插,created_by = by)。 */
async function binary(chatId: string, by: string): Promise<string> {
  const pointer = `${chatId}/${by}/${randomUUID()}-photo.png`
  await asService()
  // 登记要求对象已经在 workspace 桶里(chat.validate_workspace_storage_reference)。
  await database.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('workspace',$1)`, [pointer])
  const { rows } = await database.query<{ id: string }>(
    `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, blob_id, size_bytes, source_message_ids, created_by, version)
     VALUES ($1,'file','photo.png','image/png',chat.file_blob_for_pointer($2,3,'image/png',$3),3,'{}',$3,1) RETURNING id`,
    [chatId, pointer, by],
  )
  await asService()
  return rows[0]!.id
}
async function stored(itemId: string): Promise<{ filename: string; inline_text: string | null; size_bytes: string; version: number }> {
  await asService()
  const { rows } = await database.query<{ filename: string; inline_text: string | null; size_bytes: string; version: number }>(
    'SELECT filename, inline_text, size_bytes, version FROM chat.workspace_items WHERE id = $1', [itemId])
  return rows[0]!
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('workspaceContentThroughFiles.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  // 迁移身份建出的角色,它自己有 ADMIN 但没有 SET:测试连接要切进 gugu_files,在本事务里给自己一次(随 ROLLBACK 撤回)。
  // ⚠️ 必须写出角色名:本地 PG17 栈上 `GRANT … TO CURRENT_USER` 会让整个库进程崩溃重启(09-29 实撞)。
  await database.query("DO $$ BEGIN EXECUTE format('GRANT gugu_files TO %I', current_user); END $$")
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

describe('正文列只由文件服务写', () => {
  it('旧编辑器的整篇写回被拒(inline_text、size_bytes 各一格),正文一个字没动', async () => {
    const group = await newGroup(owner, [member])
    const doc = await document(group, owner)
    await asUser(member)
    expect(await fails('UPDATE chat.workspace_items SET inline_text = $1, size_bytes = $2, version = version + 1 WHERE id = $3', ['overwrite', 9, doc]))
      .toMatch(/permission denied for table workspace_items/)
    await asUser(owner)
    expect(await fails('UPDATE chat.workspace_items SET inline_text = $1 WHERE id = $2', ['overwrite', doc])).toMatch(/permission denied/)
    await asUser(owner)
    expect(await fails('UPDATE chat.workspace_items SET size_bytes = 1 WHERE id = $1', [doc])).toMatch(/permission denied/)
    expect(await stored(doc)).toMatchObject({ inline_text: 'body', version: 1 })
  })

  it('正对照:改名、删除走 *_as 照旧(正文不动);文件服务照写正文', async () => {
    const group = await newGroup(owner, [member])
    const doc = await document(group, member)
    const file = await binary(group, owner)
    await asUser(member)
    await database.query('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3)', [doc, member, 'renamed.md'])
    await asUser(owner)
    await database.query('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3)', [file, owner, 'cover.png'])
    expect(await stored(doc)).toMatchObject({ filename: 'renamed.md', inline_text: 'body' })
    expect(await stored(file)).toMatchObject({ filename: 'cover.png', inline_text: null })

    await asFiles()
    expect((await database.query('UPDATE chat.workspace_items SET ystate = $1, inline_text = $2, size_bytes = $3 WHERE id = $4',
      [Buffer.from([1]), 'from the file service', 21, doc])).rowCount).toBe(1)
    expect(await stored(doc)).toMatchObject({ inline_text: 'from the file service' })

    await asUser(member)
    expect((await database.query('SELECT id FROM chat.workspace_delete_as($1,$2)', [doc, member])).rows).toEqual([{ id: doc }])
  })
})
