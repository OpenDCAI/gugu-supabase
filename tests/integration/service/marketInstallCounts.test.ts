import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * chat.market_install_counts(): per market App, how many accounts installed it, as a lower bound on a 1/5
 * ladder per decade. Only signed-in callers; only (app_id, installs); never who or the exact count.
 * Every negative assertion has a positive control; every case runs inside BEGIN...ROLLBACK.
 * Run: `GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:<port>/postgres pnpm exec vitest run marketInstallCounts`
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; fields?: { name: string }[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asAnon() {
  await database.query('SET LOCAL role TO anon')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'anon' })])
}
async function asService() { await database.query('RESET role') }
async function fails(sql: string): Promise<string> {
  await database.query('SAVEPOINT expected_failure')
  try {
    await database.query(sql)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT expected_failure')
    return String((error as Error).message)
  }
  await database.query('RELEASE SAVEPOINT expected_failure')
  throw new Error(`expected failure, but succeeded: ${sql}`)
}
async function account(): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@market-counts.invalid`])
  return id
}
/** `accounts` distinct accounts install `app` (through the client RPC, like the desktop does). */
async function installedBy(app: string, accounts: number): Promise<string[]> {
  const users: string[] = []
  for (let n = 0; n < accounts; n++) {
    const user = await account()
    await asUser(user)
    await database.query('SELECT chat.record_market_install($1)', [app])
    users.push(user)
  }
  return users
}
async function counts(asWho: string): Promise<Map<string, number>> {
  await asUser(asWho)
  const { rows } = await database.query<{ app_id: string; installs: string }>('SELECT app_id, installs FROM chat.market_install_counts()')
  return new Map(rows.map((row) => [row.app_id, Number(row.installs)]))
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('marketInstallCounts.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => { await database.query('BEGIN') })
afterEach(async () => {
  if (!database) return
  try {
    await asService()
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await database.query('ROLLBACK')
  }
})

describe('chat.market_install_counts', () => {
  it('reports the lower bound of each 1/5 step, never the exact count', async () => {
    const ladder: [number, number][] = [[1, 1], [4, 1], [5, 5], [9, 5], [10, 10], [49, 10], [50, 50], [99, 50], [100, 100]]
    for (const [accounts] of ladder) await installedBy(`ladder-${accounts}`, accounts)
    const reader = await account()
    const seen = await counts(reader)
    for (const [accounts, shown] of ladder) expect([accounts, seen.get(`ladder-${accounts}`)]).toEqual([accounts, shown])
  })

  it('counts an account once per App, however often it installs (control: a second account counts)', async () => {
    const [alice] = await installedBy('radar', 1)
    await asUser(alice!)
    await database.query("SELECT chat.record_market_install('radar')")
    const reader = await account()
    expect((await counts(reader)).get('radar')).toBe(1)
    await installedBy('radar', 4)
    expect((await counts(reader)).get('radar')).toBe(5)
  })

  it('leaves out rows of other publishers (control: the gugu row of the same id counts)', async () => {
    const other = await account()
    await asService()
    await database.query("INSERT INTO chat.app_installs (user_id, app_publisher, app_id) VALUES ($1, 'someone-else', 'kanban')", [other])
    const reader = await account()
    expect((await counts(reader)).has('kanban')).toBe(false)
    await installedBy('kanban', 1)
    expect((await counts(reader)).get('kanban')).toBe(1)
  })

  it('drops a deleted account from the count', async () => {
    const users = await installedBy('forum', 5)
    const reader = await account()
    expect((await counts(reader)).get('forum')).toBe(5)
    await asService()
    await database.query('DELETE FROM auth.users WHERE id = $1', [users[0]])
    expect((await counts(reader)).get('forum')).toBe(1)
  })

  it('answers only (app_id, installs)', async () => {
    await installedBy('omnisearch', 2)
    await asUser(await account())
    const result = await database.query('SELECT * FROM chat.market_install_counts()')
    expect(result.fields?.map((field) => field.name)).toEqual(['app_id', 'installs'])
  })

  it('refuses callers that are not signed in (control: a signed-in caller reads it)', async () => {
    await installedBy('spexcode', 1)
    await asAnon()
    expect(await fails('SELECT * FROM chat.market_install_counts()')).toMatch(/permission denied/)
    expect((await counts(await account())).get('spexcode')).toBe(1)
  })

  it('keeps the rows themselves unreadable to clients (control: service_role reads them)', async () => {
    await installedBy('office', 1)
    await asUser(await account())
    expect(await fails('SELECT * FROM chat.app_installs')).toMatch(/permission denied/)
    await asService()
    const { rows } = await database.query<{ n: string }>("SELECT count(*) AS n FROM chat.app_installs WHERE app_id = 'office'")
    expect(Number(rows[0]!.n)).toBe(1)
  })
})
