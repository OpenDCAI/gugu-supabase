import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// Run only against the owned, disposable fixture. No source or release ledger
// is changed. The original function is restored even when the test runner fails.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
const marker = JSON.parse(readFileSync(new URL('../../../.local/test-db/owner.json', import.meta.url), 'utf8'))
assert.equal(marker.root, root)
assert.equal(Number(url.port), marker.port)
const db = new pg.Client({ connectionString: url.href })
await db.connect()
try {
  const { rows } = await db.query("SELECT pg_get_functiondef('chat.record_message_agent_wakes()'::regprocedure) AS sql")
  const original = rows[0].sql
  const previous = readFileSync(new URL('../../../supabase/migrations/20261022151000_reply_to_card_wakes_nobody.sql', import.meta.url), 'utf8')
  const start = previous.indexOf('CREATE OR REPLACE FUNCTION chat.record_message_agent_wakes()')
  assert.ok(start >= 0)
  const end = previous.indexOf('$$;', start) + 3
  assert.ok(end > start)
  try {
    await db.query(previous.slice(start, end))
    console.log('Mutation: remove the archived-recipient admission guard.')
    let status = 0
    try {
      execFileSync(root + 'node_modules/.bin/vitest', ['run', '--project', 'integration',
        'tests/integration/service/sessionAgentArchival.test.ts', '-t', 'refuses a group mention'], {
        cwd: root, env: process.env, stdio: 'inherit',
      })
    } catch (error) { status = error.status ?? 1 }
    console.log(`Mutated positive test exit code: ${status}`)
    assert.notEqual(status, 0, 'The positive test must reject the removed guard')
  } finally {
    await db.query(original)
    console.log('Restored the archived-recipient admission guard.')
  }
} finally { await db.end() }
