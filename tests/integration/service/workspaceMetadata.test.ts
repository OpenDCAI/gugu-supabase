import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFixtureGroup } from '../../support/groupFixture'

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
let item: string
const app = { publisher: 'gugu', id: 'kanban' }
const document = { epoch: 3 }

async function asUser(id: string) {
  await database.query('SET LOCAL ROLE authenticated')
  await database.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}

async function setNamespace(key: string, value: Record<string, unknown> | null) {
  const { rows } = await database.query<{ metadata: Record<string, unknown> }>(
    'SELECT chat.workspace_set_metadata($1,$2,$3::jsonb) AS metadata', [item, key, value === null ? null : JSON.stringify(value)])
  return rows[0]!.metadata
}

async function failure(sql: string, values: unknown[] = []) {
  await database.query('SAVEPOINT expected_failure')
  try {
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT expected_failure')
    return (error as Error).message
  } finally {
    await database.query('RELEASE SAVEPOINT expected_failure')
  }
  throw new Error('Expected the database operation to be refused')
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('workspaceMetadata.test requires a disposable loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = randomUUID()
  await database.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`, [owner, `${owner}@workspace-metadata.invalid`])
  await database.query(`INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Metadata owner')
    ON CONFLICT(id) DO UPDATE SET display_name=EXCLUDED.display_name`, [owner])
  const group = randomUUID()
  await asUser(owner)
  await createFixtureGroup(database, [group, 'Metadata fixture', owner, '[]'])
  item = (await database.query<{ id: string }>('SELECT id FROM chat.workspace_create_document_as($1,$2,$3,$4)', [group, owner, 'notes.md', 'original content'])).rows[0]!.id
  await database.query('RESET ROLE')
})
afterEach(async () => { if (database) { await database.query('RESET ROLE'); await database.query('ROLLBACK') } })

describe('shared workspace metadata', () => {
  it('defaults to an empty object and rejects a non-object root', async () => {
    expect((await database.query('SELECT metadata FROM chat.workspace_items WHERE id=$1', [item])).rows).toEqual([{ metadata: {} }])
    expect(await failure("UPDATE chat.workspace_items SET metadata='[]'::jsonb WHERE id=$1", [item])).toMatch(/workspace_items_metadata_object/)
  })

  it.each([['app', 'document'], ['document', 'app']])('preserves both namespaces when writing %s then %s', async (first, second) => {
    const values: Record<string, Record<string, unknown>> = { app, document }
    await setNamespace('other', { retained: true })
    await setNamespace(first, values[first]!)
    expect(await setNamespace(second, values[second]!)).toEqual({ app, document, other: { retained: true } })
  })

  it('replaces or removes only the selected namespace without changing content history', async () => {
    const before = (await database.query('SELECT inline_text,version,updated_at FROM chat.workspace_items WHERE id=$1', [item])).rows[0]
    await setNamespace('app', app)
    await setNamespace('document', document)
    expect(await setNamespace('document', { epoch: 4 })).toEqual({ app, document: { epoch: 4 } })
    expect(await setNamespace('app', null)).toEqual({ document: { epoch: 4 } })
    expect((await database.query('SELECT inline_text,version,updated_at FROM chat.workspace_items WHERE id=$1', [item])).rows[0]).toEqual(before)
  })

  it('keeps metadata attached to the file through a rename', async () => {
    await setNamespace('app', app)
    await setNamespace('document', document)
    await asUser(owner)
    await database.query('SELECT id FROM chat.workspace_move_as($1,$2,NULL,$3)', [item, owner, 'renamed.md'])
    expect((await database.query('SELECT metadata FROM chat.workspace_items WHERE id=$1', [item])).rows).toEqual([{ metadata: { app, document } }])
    expect(await failure("UPDATE chat.workspace_items SET metadata='{}'::jsonb WHERE id=$1", [item])).toMatch(/permission denied/)
  })

  it('leaves the internal helper closed to every API and file-service role', async () => {
    for (const role of ['anon', 'authenticated', 'service_role', 'gugu_files']) {
      expect((await database.query<{ allowed: boolean }>("SELECT has_function_privilege($1,'chat.workspace_set_metadata(uuid,text,jsonb)','EXECUTE') AS allowed", [role])).rows[0]!.allowed).toBe(false)
    }
    await asUser(owner)
    expect(await failure("SELECT chat.workspace_set_metadata($1,'app',$2::jsonb)", [item, JSON.stringify(app)])).toMatch(/permission denied/)
    expect((await database.query('SELECT metadata FROM chat.workspace_items WHERE id=$1', [item])).rows).toEqual([{ metadata: {} }])
  })

  it('refuses invalid namespaces, values and absent files without changing other metadata', async () => {
    await setNamespace('document', document)
    expect(await failure('SELECT chat.workspace_set_metadata($1,$2,$3::jsonb)', [item, ' ', '{}'])).toMatch(/needs a namespace/)
    expect(await failure('SELECT chat.workspace_set_metadata($1,$2,$3::jsonb)', [item, 'app', '[]'])).toMatch(/must be an object/)
    expect(await failure("SELECT chat.workspace_set_metadata($1,'app','{}'::jsonb)", [randomUUID()])).toMatch(/workspace item not found/)
    expect((await database.query('SELECT metadata FROM chat.workspace_items WHERE id=$1', [item])).rows).toEqual([{ metadata: { document } }])
  })
})
