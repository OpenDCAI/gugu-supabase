import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface Result<T> { rows: T[] }
interface Database {
  connect(): Promise<void>
  end(): Promise<void>
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Result<T>>
}
const { Client } = createRequire(import.meta.url)('pg') as { Client: new (options: { connectionString: string }) => Database }
let db: Database
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Requires disposable loopback PostgreSQL')
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })

async function asUser<T>(owner: string, body: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
  await db.query('SET LOCAL ROLE authenticated')
  try { return await body() } finally { await db.query('RESET ROLE').catch(() => undefined) }
}
async function rejected(body: () => Promise<unknown>, pattern: RegExp) {
  await db.query('SAVEPOINT rejected')
  try { await expect(body()).rejects.toThrow(pattern) } finally { await db.query('ROLLBACK TO SAVEPOINT rejected') }
}
interface Provision { id: string; phase: string; model: string | null; agent_user_id: string; provisioned_agent_user_id: string; dm_chat_id: string; create_command_id: string }
const provision = async (id: string) => (await db.query<Provision>('SELECT * FROM identity.agent_provisions WHERE id=$1', [id])).rows[0]
const retry = (owner: string, id: string, model: string | null) => asUser(owner, async () =>
  (await db.query<Provision>('SELECT * FROM identity.retry_agent_provision_model($1,$2)', [id, model])).rows[0])

async function fixture(body: (w: { owner: string; stranger: string; id: string; operation: string; prepare: () => Promise<void> }) => Promise<void>) {
  await db.query('BEGIN')
  try {
    const owner = randomUUID(), stranger = randomUUID(), id = randomUUID(), operation = randomUUID(), device = `retry-${randomUUID()}`
    for (const user of [owner, stranger]) {
      await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [user, `retry-${user}@example.test`])
      await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Retry test') ON CONFLICT DO NOTHING", [user])
    }
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'test','test','linux')", [device, owner])
    await asUser(owner, () => db.query('SELECT identity.start_agent_provision_operation($1,$2,$3::jsonb,NULL,NULL,$4)', [
      operation, device, JSON.stringify({ kind: 'single', members: [{ provision_id: id, member_key: 'single', display_name: 'Retry agent', agent_type: 'claude-code', project_path: '', inherit_memory: false, history_import_required: false }] }), 'platform:unavailable',
    ]))
    const prepare = () => asUser(owner, async () => {
      await db.query('SELECT identity.prepare_agent_provision($1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,NULL)', [id, operation, 'single', device, 'Retry agent', 'claude-code', ''])
    })
    await asUser(owner, () => db.query('SELECT identity.claim_provision_slots($1)', [operation]))
    await prepare()
    const first = await provision(id)
    await db.query("UPDATE identity.gugu_device_commands SET status='error',completed_at=now() WHERE id=$1", [first.create_command_id])
    await asUser(owner, () => db.query('SELECT identity.settle_agent_provision_terminal($1)', [id]))
    expect((await provision(id)).phase).toBe('failed')
    await body({ owner, stranger, id, operation, prepare })
  } finally { await db.query('ROLLBACK') }
}

describe('owned failed provision model recovery', () => {
  it('corrects the model and claims once, then prepares the same identity/DM with a new command', async () => {
    await fixture(async w => {
      const before = await provision(w.id)
      const granted = await retry(w.owner, w.id, 'platform:available')
      expect(granted).toMatchObject({ phase: 'preparing', model: 'platform:available', agent_user_id: before.agent_user_id, provisioned_agent_user_id: before.provisioned_agent_user_id, dm_chat_id: before.dm_chat_id })
      expect(await retry(w.owner, w.id, 'platform:available')).toEqual(granted)
      await rejected(() => retry(w.owner, w.id, 'platform:different'), /only a failed/)
      await w.prepare()
      const after = await provision(w.id)
      expect(after.agent_user_id).toBe(before.agent_user_id)
      expect(after.create_command_id).not.toBe(before.create_command_id)
      const commands = (await db.query<{ id: string; status: string; payload: { model: string } }>('SELECT id,status,payload FROM identity.gugu_device_commands WHERE id=ANY($1::uuid[])', [[before.create_command_id, after.create_command_id]])).rows
      expect(commands.find(c => c.id === before.create_command_id)).toMatchObject({ status: 'error', payload: { model: 'platform:unavailable' } })
      expect(commands.find(c => c.id === after.create_command_id)).toMatchObject({ status: 'pending', payload: { model: 'platform:available' } })
    })
  })
  it('rejects another owner without changing the failed record', async () => {
    await fixture(async w => {
      const before = await provision(w.id)
      await rejected(() => retry(w.stranger, w.id, 'platform:available'), /not found for caller/)
      expect(await provision(w.id)).toEqual(before)
    })
  })
  it('rejects completed and cancelled records rather than reopening them', async () => {
    await fixture(async w => {
      await retry(w.owner, w.id, 'platform:available')
      await w.prepare()
      const current = await provision(w.id)
      await db.query("UPDATE identity.gugu_device_commands SET status='done',completed_at=now() WHERE id=$1", [current.create_command_id])
      await asUser(w.owner, () => db.query('SELECT identity.settle_agent_provision_terminal($1)', [w.id]))
      await asUser(w.owner, () => db.query('SELECT identity.complete_agent_provision($1)', [w.id]))
      const completed = await provision(w.id)
      expect(completed.phase).toBe('completed')
      await rejected(() => retry(w.owner, w.id, 'platform:different'), /prior create command|only a failed|not retryable/)
      expect(await provision(w.id)).toEqual(completed)
    })
    await fixture(async w => {
      await asUser(w.owner, () => db.query('SELECT identity.cancel_agent_provision_operation($1)', [w.operation]))
      const agent = (await provision(w.id)).agent_user_id
      await asUser(w.owner, () => db.query('SELECT identity.remove_owned_agent($1)', [agent]))
      await asUser(w.owner, () => db.query('SELECT identity.settle_provision_cancellation($1)', [w.operation]))
      expect((await provision(w.id)).phase).toBe('cancelled')
      await rejected(() => retry(w.owner, w.id, 'platform:available'), /binding|not retryable|only a failed/)
      expect((await provision(w.id)).phase).toBe('cancelled')
    })
  })
  it('rejects a non-error prior command and invalid model without partial parameter changes', async () => {
    await fixture(async w => {
      const before = await provision(w.id)
      await rejected(() => retry(w.owner, w.id, 'bad model'), /model must/)
      await db.query("UPDATE identity.gugu_device_commands SET status='running' WHERE id=$1", [before.create_command_id])
      await rejected(() => retry(w.owner, w.id, 'platform:available'), /prior create command/)
      expect(await provision(w.id)).toEqual(before)
    })
  })
  it('preserves operation capacity and rolls the model back when no slot is available', async () => {
    await fixture(async w => {
      const before = await provision(w.id)
      // A blocked grant must not mutate even the requested parameter. A zero
      // concurrency limit cannot be stored, so fill the one slot with another
      // provision fixture under the same operation using its existing row shape.
      await db.query(`INSERT INTO identity.agent_provisions
        SELECT (jsonb_populate_record(NULL::identity.agent_provisions, to_jsonb(p) || jsonb_build_object('id',$2::text,'member_key','capacity-fixture','phase','preparing','agent_user_id',NULL,'provisioned_agent_user_id',NULL,'create_command_id',NULL,'dm_chat_id',NULL))).*
        FROM identity.agent_provisions p WHERE id=$1`, [w.id, randomUUID()])
      await rejected(() => retry(w.owner, w.id, 'platform:available'), /no available provision slot/)
      expect(await provision(w.id)).toEqual(before)
    })
  })
})
