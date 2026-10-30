import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient
let owner: string
let other: string

async function human(): Promise<string> {
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@device-list.invalid`])
  await database.query(`INSERT INTO identity.users (id,type,display_name) VALUES ($1,'human','Device list fixture')
    ON CONFLICT (id) DO NOTHING`, [id])
  return id
}
async function device(userId: string, capabilities: unknown): Promise<string> {
  const id = `list-${randomUUID()}`
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform,capabilities)
    VALUES ($1,$2,'Device list fixture','fixture','darwin',$3::jsonb)`, [id, userId, JSON.stringify(capabilities)])
  return id
}
async function asUser(userId: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: 'authenticated' })])
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('deviceListCapabilities.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human()
  other = await human()
})
afterEach(async () => {
  if (!database) return
  try {
    await database.query('RESET role')
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await database.query('ROLLBACK')
  }
})

describe('device-list capabilities', () => {
  it('preserves ordered action summaries and the original full manifest under owner RLS', async () => {
    const actions = Array.from({ length: 92 }, (_, i) => ({
      name: `files.action${i}`, group: 'files', title: `Action ${i}`,
      description: `Full documentation for action ${i}`, input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      available: i % 2 === 0, risk: 'medium', confirm: 'on_conflict',
      unavailable_reason: 'not_granted', unavailable_detail: 'Enable files in device settings',
    }))
    const full = {
      terminals: ['terminal'], runtimes: ['codex'], host_runtime_capability: 1, app_version: '0.0.1',
      actions: { v: 1, updated_at: '2026-10-24T00:00:00Z', timezone: 'Asia/Shanghai',
        switched_off: [{ group: 'computer', detail: 'Enable the computer app' }], actions },
    }
    const deviceId = await device(owner, full)
    await device(other, full)
    await asUser(owner)
    const { rows } = await database.query<{ device_id: string; full: unknown; summary: unknown }>(
      `SELECT d.device_id, d.capabilities AS full, identity.device_list_capabilities(d) AS summary
        FROM identity.gugu_devices d ORDER BY d.device_id`)
    expect(rows).toEqual([{
      device_id: deviceId,
      full,
      summary: { ...full, actions: { ...full.actions, actions: actions.map(({ description: _description, input_schema: _schema, ...summary }) => summary) } },
    }])
  })

  it.each([{}, { runtimes: ['codex'] }, { actions: { v: 1, actions: [] } }])('preserves absent and empty manifests: %j', async (capabilities) => {
    const deviceId = await device(owner, capabilities)
    await asUser(owner)
    const { rows } = await database.query<{ summary: unknown }>(
      'SELECT identity.device_list_capabilities(d) AS summary FROM identity.gugu_devices d WHERE device_id=$1', [deviceId])
    expect(rows).toEqual([{ summary: capabilities }])
  })

  it('starts closed to anonymous calls and retains invoker semantics without a named RPC argument', async () => {
    const { rows } = await database.query<{ authenticated: boolean; anonymous: boolean; definer: boolean; argnames: string[] | null }>(
      `SELECT has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
        has_function_privilege('anon',p.oid,'EXECUTE') AS anonymous, p.prosecdef AS definer, p.proargnames AS argnames
        FROM pg_proc p WHERE p.oid='identity.device_list_capabilities(identity.gugu_devices)'::regprocedure`)
    expect(rows).toEqual([{ authenticated: true, anonymous: false, definer: false, argnames: null }])
  })
})
