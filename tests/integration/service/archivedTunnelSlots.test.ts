import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

type Refusal = {
  limit: 'total' | 'tunnel'; used: number; max: number
  machine_id: string; via: string
  machines: { machine_id: string; label: string; device_ids: string[] }[]
}
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let db: DatabaseClient
let owner: string

async function asUser(userId = owner) {
  await db.query('SET LOCAL role TO authenticated')
  await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: 'authenticated' })])
}
async function service() {
  await db.query('RESET role')
  await db.query("SELECT set_config('request.jwt.claims', '{}', true)")
}
async function account() {
  const id = randomUUID()
  await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`, [id, `${id}@tunnel-slots.invalid`])
  return id
}
async function device(machine: string, options: {
  age?: string; status?: 'online' | 'offline'; kind?: string; via?: string; owner?: string
} = {}) {
  await service()
  const id = `tunnel-slot-${randomUUID()}`
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,machine_id,label,hostname,platform,status,last_seen_at,capabilities,tier)
    VALUES($1,$2,$3,$3,'fixture','linux',$4,now()-$5::interval,$6::jsonb,$7)`, [
    id, options.owner ?? owner, machine, options.status ?? 'offline', options.age ?? '1 day',
    JSON.stringify({ host_kind: options.kind ?? 'server', connect_via: options.via ?? 'tunnel' }), id,
  ])
  return id
}
async function refusal(machine = 'candidate', via = 'tunnel', userId = owner) {
  const { rows } = await db.query<{ refusal: Refusal | null }>(
    'SELECT identity.gugu_machine_limit_refusal($1,$2,$3) AS refusal', [userId, machine, via])
  return rows[0]!.refusal
}
async function failure(sql: string, values: unknown[] = []) {
  await db.query('SAVEPOINT expected_failure')
  try {
    await db.query(sql, values)
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT expected_failure')
    return String((error as Error).message)
  }
  throw new Error('Expected the database to reject this operation')
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('archivedTunnelSlots requires a disposable loopback database')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = await account()
  await db.query('UPDATE identity.installation_machine_limits SET max_machines=10,max_tunnel_machines=1 WHERE id')
})
afterEach(async () => {
  if (!db) return
  try { await service(); await db.query('SET CONSTRAINTS ALL IMMEDIATE') }
  finally { await db.query('ROLLBACK') }
})

describe('archived tunnel slots', () => {
  it.each([
    ['7 days 1 microsecond', false],
    ['7 days', true],
    ['6 days 23 hours 59 minutes 59 seconds', true],
  ])('uses a strict seven-day boundary: %s', async (age, occupies) => {
    const id = await device('boundary', { age })
    await asUser()
    const result = await refusal()
    if (!occupies) expect(result).toBeNull()
    else expect(result).toMatchObject({ limit: 'tunnel', used: 1, max: 1,
      machines: [{ machine_id: 'boundary', label: 'boundary', device_ids: [id] }] })
  })

  it('keeps online endpoints and unknown last-seen times active', async () => {
    const online = await device('online', { status: 'online', age: '20 days' })
    const unknown = await device('unknown')
    await db.query("UPDATE identity.gugu_devices SET last_seen_at='-infinity' WHERE device_id=$1", [unknown])
    await asUser()
    expect(await refusal()).toMatchObject({ limit: 'tunnel', used: 2, machines: [
      { machine_id: 'online', device_ids: [online] }, { machine_id: 'unknown', device_ids: [unknown] },
    ] })
  })

  it('groups all versions before archiving and counts a machine once', async () => {
    const first = await device('versions', { age: '20 days' })
    const second = await device('versions', { age: '10 days' })
    const desktop = await device('versions', { kind: 'desktop', age: '1 day' })
    await asUser()
    expect(await refusal()).toMatchObject({ used: 1, machines: [
      { machine_id: 'versions', device_ids: [first, second, desktop].sort() },
    ] })
    await service()
    await db.query("UPDATE identity.gugu_devices SET last_seen_at=now()-interval '8 days' WHERE device_id=$1", [desktop])
    await asUser()
    expect(await refusal()).toBeNull()
    expect(await refusal('versions')).toBeNull()
  })

  it('preserves server host-kind and enrollment policy instead of trusting client connection labels', async () => {
    await device('desktop', { kind: 'desktop' })
    await device('phone', { kind: 'phone' })
    await device('ssh', { via: 'tunnel' })
    await db.query("INSERT INTO identity.gugu_server_enrollments(user_id,machine_id,via) VALUES($1,'ssh','ssh')", [owner])
    await device('tunnel', { via: 'ssh' })
    await asUser()
    expect(await refusal()).toMatchObject({ used: 1, machines: [{ machine_id: 'tunnel' }] })
    expect(await refusal('candidate', 'ssh')).toBeNull()
    expect(await refusal('tunnel')).toBeNull()
  })

  it('retains archived registrations in the total machine limit', async () => {
    await device('archived', { age: '8 days' })
    await device('recent')
    await db.query('UPDATE identity.installation_machine_limits SET max_machines=2 WHERE id')
    await asUser()
    expect(await refusal()).toMatchObject({ limit: 'total', used: 2, max: 2,
      machines: [{ machine_id: 'archived' }, { machine_id: 'recent' }] })
  })

  it('does not bypass a full tunnel quota when an archived server heartbeats again', async () => {
    const returning = await device('returning', { age: '8 days' })
    await device('active')
    await asUser()
    expect(await refusal('returning')).toMatchObject({ limit: 'tunnel', used: 1 })
    expect(await failure("UPDATE identity.gugu_devices SET status='online',last_seen_at=now() WHERE device_id=$1", [returning]))
      .toContain('DEVICE_LIMIT_REACHED')
    // Editing an archived row does not reactivate it or require a free slot.
    await db.query("SELECT identity.rename_device($1,'Still archived')", [returning])
    expect(await refusal('returning')).toMatchObject({ used: 1 })
  })

  it('keeps the slot until every endpoint is removed, then allows a real authenticated insert', async () => {
    const first = await device('versions')
    const second = await device('versions')
    await asUser()
    expect(await refusal()).toMatchObject({ used: 1 })
    expect(await failure(`INSERT INTO identity.gugu_devices(device_id,user_id,machine_id,label,hostname,platform,capabilities)
      VALUES('new-machine',$1,'candidate','candidate','fixture','linux','{"host_kind":"server"}')`, [owner]))
      .toContain('DEVICE_LIMIT_REACHED')
    await db.query('SELECT identity.remove_device($1)', [first])
    expect(await refusal()).toMatchObject({ used: 1, machines: [{ device_ids: [second] }] })
    await db.query('SELECT identity.remove_device($1)', [second])
    expect(await refusal()).toBeNull()
    await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,machine_id,label,hostname,platform,capabilities)
      VALUES('new-machine',$1,'candidate','candidate','fixture','linux','{"host_kind":"server"}')`, [owner])
    expect(await refusal('another')).toMatchObject({ used: 1, machines: [{ machine_id: 'candidate' }] })
  })

  it('refreshes recent refusal occupants rather than replaying a removed machine snapshot', async () => {
    const id = await device('occupant')
    await db.query(`INSERT INTO identity.server_login_requests(device_code_hash,user_code,machine_id,status,refusal,refused_user_id,refused_at)
      VALUES($1,$2,'candidate','refused','{"limit":"tunnel","used":1,"max":1}',$3,now())`, [randomUUID(), randomUUID(), owner])
    await asUser()
    const recent = async () => (await db.query<{ refusal: Refusal | null }>(
      "SELECT identity.my_recent_machine_limit_refusal(now()-interval '1 minute') AS refusal")).rows[0]!.refusal
    expect(await recent()).toMatchObject({ used: 1, machines: [{ device_ids: [id] }] })
    await db.query('SELECT identity.remove_device($1)', [id])
    expect(await recent()).toBeNull()
  })

  it('enforces ownership and keeps anonymous callers out', async () => {
    const other = await account()
    await device('private', { owner: other })
    await asUser(other)
    expect(await refusal('candidate', 'tunnel', other)).toMatchObject({ used: 1 })
    await asUser()
    expect(await refusal()).toBeNull()
    expect(await failure('SELECT identity.gugu_machine_limit_refusal($1,$2,$3)', [other, 'candidate', 'tunnel']))
      .toContain('can only check the caller')
    await db.query('SET LOCAL role TO anon')
    expect(await failure('SELECT identity.gugu_machine_limit_refusal($1,$2,$3)', [owner, 'candidate', 'tunnel']))
      .toContain('permission denied')
  })
})
