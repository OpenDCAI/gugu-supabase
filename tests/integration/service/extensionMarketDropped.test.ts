import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * App 市场不在库里了(迁移 20261008012004_drop_extension_market):两张表、清单视图、三个触发器函数、storage 上两条读策略、两个桶都没有了。
 * 只读,不留数据。
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

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('extensionMarketDropped.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })

describe('extension market dropped from the database', () => {
  it('no tables, view or trigger functions remain', async () => {
    const { rows } = await database.query<{ name: string; present: boolean }>(
      `SELECT name, to_regclass(name) IS NOT NULL AS present
         FROM unnest(ARRAY['public.market_extensions', 'public.market_extension_versions', 'public.market_available']) AS name`)
    expect(rows.filter((row) => row.present)).toEqual([])
    const functions = await database.query(
      `SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
          AND proname IN ('market_versions_are_immutable', 'market_latest_must_be_installable', 'market_after_yank_move_latest')`)
    expect(functions.rows).toEqual([])
  })

  it('no buckets and no storage policies of the market remain', async () => {
    const buckets = await database.query(`SELECT id FROM storage.buckets WHERE id IN ('extension-bundles', 'extension-media')`)
    expect(buckets.rows).toEqual([])
    const policies = await database.query(
      `SELECT policyname FROM pg_policies WHERE schemaname = 'storage'
          AND policyname IN ('extension_bundles_read_listed', 'extension_media_public_read')`)
    expect(policies.rows).toEqual([])
  })

  it('positive control: the same reads see objects that do exist', async () => {
    const { rows } = await database.query<{ present: boolean }>(`SELECT to_regclass('storage.buckets') IS NOT NULL AS present`)
    expect(rows).toEqual([{ present: true }])
  })
})
