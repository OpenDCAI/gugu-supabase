import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 迁移 20261019131651:gugu 市场首页精选按近期安装量排。
 *   · chat.record_market_install(app_id):当前账号、当前时刻记一票;同一账号同一 App 只有一行;没登录的写不了。
 *   · chat.market_install_ranking():近 14 天、每个账号一票、7 天减半;不到 3 个账号的 App 不出现;不返回谁装的。
 *   · 客户端碰不到表(读、写都不行);账号删掉,它的行跟着走。
 * 每条否定断言配正对照;每条用例 BEGIN…ROLLBACK。
 * 跑法:`GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:<port>/postgres pnpm exec vitest run marketInstallRanking`
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

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asAnon() {
  await database.query('SET LOCAL role TO anon')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'anon' })])
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
async function account(): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@market-ranking.invalid`])
  return id
}
async function install(user: string, app: string) {
  await asUser(user)
  await database.query('SELECT chat.record_market_install($1)', [app])
}
/** 直接写一行带日期的(只有 service 写得了):造「几天前装的」。 */
async function installedDaysAgo(app: string, days: number) {
  const user = await account()
  await asService()
  await database.query(`INSERT INTO chat.app_installs (user_id, app_publisher, app_id, first_at) VALUES ($1, 'gugu', $2, now() - $3 * interval '1 day')`, [user, app, days])
}
async function ranking(asWho: string): Promise<Map<string, number>> {
  await asUser(asWho)
  const { rows } = await database.query<{ app_id: string; score: number }>('SELECT app_id, score FROM chat.market_install_ranking()')
  return new Map(rows.map((row) => [row.app_id, row.score]))
}
async function rowsOf(app: string): Promise<number> {
  await asService()
  const { rows } = await database.query<{ n: string }>(`SELECT count(*) AS n FROM chat.app_installs WHERE app_id = $1`, [app])
  return Number(rows[0]!.n)
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('marketInstallRanking.test requires a loopback PostgreSQL database')
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

describe('chat.record_market_install', () => {
  it('同一账号同一 App 只有一行(再装、更新都不加);另一个账号再加一行', async () => {
    const alice = await account()
    const bob = await account()
    await install(alice, 'radar')
    await install(alice, 'radar')
    expect(await rowsOf('radar')).toBe(1)
    await install(bob, 'radar')
    expect(await rowsOf('radar')).toBe(2)
  })

  it('写的是当前账号、市场的发布者 gugu、当前时刻', async () => {
    const alice = await account()
    await install(alice, 'kanban')
    await asService()
    const { rows } = await database.query<{ user_id: string; app_publisher: string; fresh: boolean }>(
      `SELECT user_id, app_publisher, first_at = now() AS fresh FROM chat.app_installs WHERE app_id = 'kanban'`
    )
    expect(rows).toEqual([{ user_id: alice, app_publisher: 'gugu', fresh: true }])
  })

  it('没登录的写不了(对照:登录了写得进)', async () => {
    await asAnon()
    expect(await fails(`SELECT chat.record_market_install('radar')`)).toMatch(/permission denied/)
    await asUser(randomUUID())
    // 登录了但账号不存在(外键):写不进,❌ 悄悄成功。
    expect(await fails(`SELECT chat.record_market_install('radar')`)).toMatch(/foreign key|violates/)
    await install(await account(), 'radar')
    expect(await rowsOf('radar')).toBe(1)
  })
})

describe('客户端碰不到表', () => {
  it('authenticated 读不到、写不了 chat.app_installs(对照:service 读得到)', async () => {
    const alice = await account()
    await install(alice, 'radar')
    await asUser(alice)
    expect(await fails(`SELECT * FROM chat.app_installs`)).toMatch(/permission denied/)
    expect(await fails(`INSERT INTO chat.app_installs (user_id, app_publisher, app_id, first_at) VALUES ($1, 'gugu', 'radar', now() - interval '10 days')`, [alice])).toMatch(/permission denied/)
    expect(await rowsOf('radar')).toBe(1)
  })

  it('账号删掉,它的行跟着走', async () => {
    const alice = await account()
    await install(alice, 'radar')
    await asService()
    await database.query('DELETE FROM auth.users WHERE id = $1', [alice])
    expect(await rowsOf('radar')).toBe(0)
  })
})

describe('chat.market_install_ranking', () => {
  it('不到 3 个账号的 App 不出现;到 3 个就出现,今天装的每票算 1', async () => {
    for (let i = 0; i < 2; i += 1) await install(await account(), 'radar')
    for (let i = 0; i < 3; i += 1) await install(await account(), 'kanban')
    const scores = await ranking(await account())
    expect(scores.has('radar')).toBe(false)
    expect(scores.get('kanban')).toBeCloseTo(3, 6)
  })

  it('7 天减半;14 天以前装的不算', async () => {
    for (const days of [0, 7, 13]) await installedDaysAgo('office', days)
    expect((await ranking(await account())).get('office')).toBeCloseTo(1 + 0.5 + 0.5 ** (13 / 7), 6)
    // 第三个账号是 15 天前装的:近 14 天只剩两个账号,整个 App 不出现。
    for (const days of [0, 7, 15]) await installedDaysAgo('paper-club', days)
    expect((await ranking(await account())).has('paper-club')).toBe(false)
  })

  it('近期装得多的排在存量多的前面', async () => {
    for (let i = 0; i < 4; i += 1) await installedDaysAgo('fresh', 0)
    for (let i = 0; i < 6; i += 1) await installedDaysAgo('older', 10)
    const scores = await ranking(await account())
    expect(scores.get('fresh')!).toBeGreaterThan(scores.get('older')!)
  })

  it('没登录的读不了(对照:登录了读得到)', async () => {
    for (let i = 0; i < 3; i += 1) await install(await account(), 'radar')
    await asAnon()
    expect(await fails('SELECT * FROM chat.market_install_ranking()')).toMatch(/permission denied/)
    expect((await ranking(await account())).has('radar')).toBe(true)
  })
})
