/** runtime_status / derived_status 退场第一步(签名不动)。
 * 判据:① set_agent_runtime_state 不再听 p_runtime_status:新行记 offline,老行留原值,其余字段照写;
 * ② presence 载荷不再带 derived_status,runtime_status 照旧在;③ set_agent_desired_status 不再往
 * agent:<id>:runtime 发 runtime_changed,下线照旧给设备发 agent.stop(阳控);④ desired 一改,查看方就收到
 * presence_changed 修订(下线 / 上线都实时到,不再等对方整页刷新)。只连 loopback 库,每个用例用自己的 agent。
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface Client {
  connect(): Promise<void>
  end(): Promise<void>
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}
const { Client: PgClient } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => Client
}
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? ''
let db: Client

beforeAll(async () => {
  const parsed = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('runtimeDerivedStatusRetired requires disposable loopback PostgreSQL')
  }
  db = new PgClient({ connectionString: url })
  await db.connect()
  await db.query("SET statement_timeout='10s'")
})
afterAll(async () => { await db?.end() })

interface Fixture { owner: string; agent: string; device: string }
async function fixture(body: (f: Fixture) => Promise<void>): Promise<void> {
  const f: Fixture = { owner: randomUUID(), agent: randomUUID(), device: `runtime-retired-${randomUUID()}` }
  try {
    await db.query('INSERT INTO auth.users(id,email) VALUES ($1::uuid,$2)', [f.owner, `runtime-retired-${f.owner}@example.test`])
    await db.query("INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human','retired owner') ON CONFLICT (id) DO NOTHING", [f.owner])
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,status) VALUES ($1,$2,'retired','isolated','linux','online')", [f.device, f.owner])
    await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,desired_status) VALUES ($1,'agent','retired agent',$2,$3,'online')", [f.agent, f.owner, f.device])
    await body(f)
  } finally {
    await db.query('ROLLBACK').catch(() => undefined)
    await db.query('DELETE FROM identity.gugu_device_commands WHERE device_id=$1', [f.device])
    await db.query('DELETE FROM identity.agent_runtime_states WHERE agent_user_id=$1', [f.agent])
    await db.query('DELETE FROM identity.users WHERE id=$1', [f.agent])
    await db.query('DELETE FROM identity.gugu_devices WHERE device_id=$1', [f.device])
    await db.query('DELETE FROM auth.users WHERE id=$1::uuid', [f.owner])
    await db.query('DELETE FROM chat.account_revision_heads WHERE user_id=$1', [f.owner])
    await db.query('DELETE FROM chat.presence_wake_throttles WHERE viewer_user_id=$1', [f.owner])
    await db.query('DELETE FROM realtime.messages WHERE topic=$1', [`agent:${f.agent}:runtime`])
  }
}

/** 主人以 authenticated 身份调一次 RPC(与客户端同一个角色、同一个 auth.uid())。 */
async function asOwner(owner: string, sql: string, values: unknown[]): Promise<void> {
  await db.query('BEGIN')
  try {
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
    await db.query('SET LOCAL ROLE authenticated')
    await db.query(sql, values)
    await db.query('COMMIT')
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  }
}

const WRITE = `SELECT identity.set_agent_runtime_state(
  p_agent_user_id => $1, p_runtime_status => $2, p_activity_status => 'running',
  p_agent_status => 'working', p_agent_status_detail => 'running')`

async function row(agent: string): Promise<Record<string, unknown>> {
  return (await db.query('SELECT runtime_status, activity_status, agent_status FROM identity.agent_runtime_states WHERE agent_user_id=$1', [agent])).rows[0]!
}

async function presence(agent: string): Promise<Record<string, unknown>> {
  const rows = await db.query<{ payload: { presence: Record<string, unknown> } }>(
    'SELECT identity.build_agent_presence_payload($1) AS payload', [agent])
  return rows.rows[0]!.payload.presence
}

describe('runtime_status / derived_status 退场(签名不动)', () => {
  it('set_agent_runtime_state 不听 p_runtime_status:新行记 offline,其余字段照写', async () => fixture(async (f) => {
    await asOwner(f.owner, WRITE, [f.agent, 'online'])
    expect(await row(f.agent)).toEqual({ runtime_status: 'offline', activity_status: 'running', agent_status: 'working' })
  }))

  it('老行的 runtime_status 留原值(这次不再改它)', async () => fixture(async (f) => {
    await db.query("INSERT INTO identity.agent_runtime_states(agent_user_id, owner_user_id, runtime_status, activity_status, last_seen_at) VALUES ($1,$2,'online','idle', now() - interval '1 minute')", [f.agent, f.owner])
    await asOwner(f.owner, WRITE, [f.agent, 'offline'])
    expect(await row(f.agent)).toEqual({ runtime_status: 'online', activity_status: 'running', agent_status: 'working' })
  }))

  it('presence 载荷不再带 derived_status;runtime_status 照旧在(老客户端拿它回退)', async () => fixture(async (f) => {
    await asOwner(f.owner, WRITE, [f.agent, 'online'])
    const payload = await presence(f.agent)
    expect(payload).not.toHaveProperty('derived_status')
    expect(payload).toMatchObject({ runtime_status: 'offline', desired_status: 'online', activity_status: 'running' })
  }))

  it('set_agent_desired_status 不再发 runtime_changed;下线照旧给设备发 agent.stop', async () => fixture(async (f) => {
    const topic = `agent:${f.agent}:runtime`
    await asOwner(f.owner, 'SELECT identity.set_agent_desired_status($1, $2)', [f.agent, 'offline'])
    const sent = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM realtime.messages WHERE topic=$1', [topic])
    expect(sent.rows[0]!.n).toBe('0')
    const stops = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM identity.gugu_device_commands WHERE device_id=$1 AND type='agent.stop' AND payload->>'agent_user_id'=$2",
      [f.device, f.agent])
    expect(stops.rows[0]!.n).toBe('1')
  }))

  it('desired 一改,查看方就收到 presence_changed 修订(下线、再上线各一次)', async () => fixture(async (f) => {
    const revisions = async (): Promise<number> => Number((await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM chat.account_revisions WHERE user_id=$1 AND event='presence_changed'", [f.owner])).rows[0]!.n)
    const before = await revisions()
    await asOwner(f.owner, 'SELECT identity.set_agent_desired_status($1, $2)', [f.agent, 'offline'])
    const offline = await revisions()
    expect(offline).toBeGreaterThan(before)
    expect(await presence(f.agent)).toMatchObject({ desired_status: 'offline' })
    await asOwner(f.owner, 'SELECT identity.set_agent_desired_status($1, $2)', [f.agent, 'online'])
    expect(await revisions()).toBeGreaterThan(offline)
  }))
})
