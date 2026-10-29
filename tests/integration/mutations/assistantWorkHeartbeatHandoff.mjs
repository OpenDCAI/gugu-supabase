import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
const marker = JSON.parse(readFileSync(new URL('../../../.local/test-db/owner.json', import.meta.url), 'utf8'))
assert.equal(marker.root, root)
assert.equal(Number(url.port), marker.port)
const db = new pg.Client({ connectionString: url.href })
await db.connect()
try {
  const original = (await db.query("SELECT pg_get_functiondef('identity.assistant_work_prompt_ready_target()'::regprocedure) AS sql")).rows[0].sql
  const cleanup = (await db.query("SELECT pg_get_functiondef('identity.assistant_work_retire_ready_hint()'::regprocedure) AS sql")).rows[0].sql
  const replace = (text, from, to) => { assert.ok(text.includes(from), 'Mutation source must match'); return text.replace(from, to) }
  const variants = [
    ['remove heartbeat handoff', 'prompts a resumed', original.replace('IF v_count>0 THEN', 'IF false THEN')],
    ['repeat unchanged retry hints', 'aggregates ready work', replace(replace(original,
      "AND (prior.event_seq IS NULL OR prior.target_device_id IS DISTINCT FROM NEW.device_id\n          OR prior.eligible_at IS DISTINCT FROM ready.eligible_at)", 'AND true'),
      "WHERE hinted.target_device_id IS DISTINCT FROM EXCLUDED.target_device_id\n          OR hinted.eligible_at IS DISTINCT FROM EXCLUDED.eligible_at", 'WHERE true')],
    ['ignore future availability', 'not due', replace(original, "e.available_at<=v_now", 'true')],
    ['ignore live delivery lease', 'active lease', replace(original, "e.lease_until<v_now", 'true')],
    ['ignore runtime ownership', 'wrong owner', replace(original,
      "OR NOT EXISTS (SELECT 1 FROM identity.gugu_devices d\n        WHERE d.device_id=NEW.device_id AND d.user_id=NEW.owner_user_id)", 'OR false')],
    ['ignore claimant cooldown', 'claimant cooldown', replace(original, 'c.retry_after>v_now', 'false')],
    ['ignore older queued work', 'ordered behind', replace(original, 'AND older.seq<e.seq', 'AND false')],
    ['ignore event expiry', 'expired work', replace(original, "e.platform_received_at>v_now-interval '24 hours'", 'true')],
    ['ignore stale heartbeat', 'stale heartbeat', replace(original, "NEW.last_heartbeat_at<=v_now-interval '90 seconds'", 'false')],
    ['wait for a concurrently locked event', 'another connection', replace(original, ' SKIP LOCKED', '')],
    ['retain settled hint receipts', 'retires a hint on abandonment', cleanup.replace("DELETE FROM identity.assistant_work_ready_hints WHERE event_seq=NEW.seq;", 'NULL;'), 'cleanup'],
  ]
  for (const [name, filter, sql, target] of variants) {
    assert.notEqual(sql, target === 'cleanup' ? cleanup : original)
    try {
      await db.query(sql)
      console.log('Mutation: ' + name)
      let error
      try {
        execFileSync(root + 'node_modules/.bin/vitest', ['run', '--project', 'integration', 'tests/integration/service/assistantWorkOutboxDevice.test.ts', '-t', filter], {
          cwd: root, env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (failure) { error = failure }
      const output = String(error?.stdout ?? '') + String(error?.stderr ?? '')
      console.log(output)
      console.log('Mutated positive test exit code: ' + error?.status)
      assert.equal(error?.status, 1, 'Mutation must fail normally, not hang or crash')
      assert.match(output, /AssertionError/, 'Mutation must be caught by a behavior assertion')
      assert.doesNotMatch(output, /permission denied|does not exist/, 'DDL or fixture failures are not mutation evidence')
    } finally {
      await db.query(original)
      await db.query(cleanup)
    }
  }
  console.log('Restored both trigger functions after all mutations.')
} finally { await db.end() }
