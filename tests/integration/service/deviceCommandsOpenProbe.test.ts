import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Cloud-computer controllers ask, per sleeping device, whether it has open commands:
 * GET gugu_device_commands?select=id,status&device_id=eq.X&status=in.(pending,running).
 * That probe must be an index lookup for both custom and generic plans; without one, every probe
 * scanned the whole table. Sequential scans are disabled so the answer does not depend on table size.
 */
interface Client {
  connect(): Promise<void>
  end(): Promise<void>
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}
const { Client: PgClient } = createRequire(import.meta.url)('pg') as { Client: new (config: { connectionString: string }) => Client }
let db: Client
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('deviceCommandsOpenProbe requires a loopback PostgreSQL database')
  }
  db = new PgClient({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })

describe('open device command probe', () => {
  it.each(['force_custom_plan', 'force_generic_plan'])('is an index lookup on device and status (%s)', async mode => {
    await db.query('BEGIN')
    try {
      await db.query('SET LOCAL enable_seqscan = off')
      await db.query(`SET LOCAL plan_cache_mode = ${mode}`)
      await db.query('PREPARE open_probe(text, text[]) AS SELECT id, status FROM identity.gugu_device_commands WHERE device_id = $1 AND status = ANY($2)')
      const { rows } = await db.query<{ 'QUERY PLAN': string }>("EXPLAIN EXECUTE open_probe('probe-device', '{pending,running}')")
      const plan = rows.map(r => r['QUERY PLAN']).join('\n')
      expect(plan).toContain('idx_gugu_device_commands_device_status')
      expect(plan).toMatch(/Index Cond: \(\(device_id = /)
    } finally {
      await db.query('ROLLBACK')
      await db.query('DEALLOCATE ALL')
    }
  })
})
