import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * gugu #7348 新账号的第一次打开:走完由本人记上(identity.finish_first_run)。
 * 只记调用者自己那一行、可重复调用、agent 身份记不上(返回 NULL,客户端据此报错)、匿名调不了。
 * 以 authenticated 身份 + 真 JWT claims 跑;每条用例 BEGIN…ROLLBACK。
 */

interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}

let database: DatabaseClient
let alice: string
let bob: string
let agent: string

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asService() { await database.query('RESET role') }
async function onboardedAt(id: string) {
  await asService()
  const { rows } = await database.query<{ onboarded_at: Date | null }>('SELECT onboarded_at FROM identity.users WHERE id = $1', [id])
  return rows[0]?.onboarded_at ?? null
}
async function finish(id: string) {
  await asUser(id)
  const { rows } = await database.query<{ finish_first_run: Date | null }>('SELECT identity.finish_first_run()')
  return rows[0]?.finish_first_run ?? null
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('finishFirstRun7348.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  alice = randomUUID(); bob = randomUUID(); agent = randomUUID()
  for (const id of [alice, bob]) {
    await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
    [id, `${id}@first-run-fixture.invalid`])
  }
  // 新注册的账号:onboarded_at 为空(回填只补迁移那一刻已存在的真人)。
  await database.query(`INSERT INTO identity.users (id, type, display_name, onboarded_at) VALUES ($1,'human','Alice',NULL),($2,'human','Bob',NULL)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, onboarded_at = NULL`, [alice, bob])
  const device = `first-run-${alice}`
  await database.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES ($1,$2,'fixture','fixture','linux')`, [device, alice])
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id) VALUES ($1,'agent','Alice Agent',$2,$3)`, [agent, alice, device])
})
afterEach(async () => {
  if (!database) return
  try {
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await database.query('ROLLBACK')
  }
})

describe('identity.finish_first_run (gugu #7348)', () => {
  it('stamps only the caller and returns the stamp', async () => {
    const stamped = await finish(alice)
    expect(stamped).not.toBeNull()
    expect((await onboardedAt(alice))?.toISOString()).toBe(stamped?.toISOString())
    expect(await onboardedAt(bob)).toBeNull()
  })

  it('is idempotent: a second call keeps the first stamp', async () => {
    const first = await finish(alice)
    const second = await finish(alice)
    expect(second?.toISOString()).toBe(first?.toISOString())
  })

  it('records nothing for a non-human identity (returns NULL so the client reports it)', async () => {
    expect(await finish(agent)).toBeNull()
    expect(await onboardedAt(agent)).toBeNull()
  })

  it('is not callable anonymously', async () => {
    await database.query('SAVEPOINT anon_call')
    await database.query('SET LOCAL role TO anon')
    let message = ''
    try {
      await database.query('SELECT identity.finish_first_run()')
    } catch (error) {
      message = String((error as Error).message)
    }
    await database.query('ROLLBACK TO SAVEPOINT anon_call')
    expect(message).toMatch(/permission denied/)
  })
})
