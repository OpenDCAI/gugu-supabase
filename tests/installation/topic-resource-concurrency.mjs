import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// Run only before the topic release on this checkout's disposable database.
// Warm the real old trigger plans; a newly connected writer is not equivalent.
export async function installTopicResourcesConcurrently(db, sql, test) {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const status = JSON.parse(execFileSync(root + 'node_modules/.bin/supabase', ['status', '--workdir', root + '.local/test-db', '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  const database = new URL(process.env.GUGU_INSTALL_TEST_DATABASE_URL)
  const api = new URL(status.API_URL), actual = new URL(status.DB_URL)
  assert.equal(database.hostname, '127.0.0.1'); assert.equal(actual.host, database.host)
  assert.equal(api.hostname, '127.0.0.1'); assert.equal(Number(api.port), Number(database.port) - 1)
  const monitor = new pg.Client({ connectionString: database.href })
  await monitor.connect()
  const source = randomUUID(), topic = randomUUID(), device = 'topic-upgrade-' + randomUUID()
  const agents = Array.from({ length: 4 }, randomUUID)
  const email = randomUUID() + '@topic-upgrade.example.test', password = randomUUID() + randomUUID()
  const request = (path, body, token = status.SERVICE_ROLE_KEY, method = 'POST') => fetch(api.origin + path, {
    method, headers: { apikey: status.ANON_KEY, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  })
  const login = () => request('/auth/v1/token?grant_type=password', { email, password }, status.ANON_KEY)
  let owner, token, pointer, storagePath
  const writerOf = async () => {
    const writer = new pg.Client({ connectionString: database.href })
    await writer.connect()
    await writer.query('BEGIN')
    await asOwner(writer)
    await writer.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'warm old message trigger plans')", [randomUUID(), topic, owner])
    await writer.query('COMMIT')
    return writer
  }
  async function asOwner(writer) {
    await writer.query('SET LOCAL ROLE authenticated')
    await writer.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',json_build_object('sub',$1::text,'role','authenticated')::text,true)", [owner])
  }
  const boundary = sql.indexOf('-- This helper')
  const commit = sql.lastIndexOf('COMMIT;')
  assert.ok(boundary > 0 && commit > boundary)
  const head = sql.slice(0, boundary), body = sql.slice(boundary, commit)
  const migrationPid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  async function blocked(pid, pending) {
    let state = 'pending'
    pending.then(() => { state = 'settled' }, () => { state = 'failed' })
    for (;;) {
      assert.equal(state, 'pending', 'the real statement must wait on the migration')
      const { rows } = await monitor.query(`SELECT l.relation::regclass::text AS relation FROM pg_locks l
        WHERE l.pid=$1 AND NOT l.granted AND $2=ANY(pg_blocking_pids(l.pid))`, [pid, migrationPid])
      if (rows.length) return rows.map((r) => r.relation)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  async function blockedHttp(namespace, pending) {
    let state = 'pending'
    pending.then(() => { state = 'settled' }, () => { state = 'failed' })
    for (;;) {
      assert.equal(state, 'pending', 'the real HTTP request must wait on the migration')
      const { rows } = await monitor.query(`SELECT l.pid FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
        JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE NOT l.granted AND $1=ANY(pg_blocking_pids(l.pid)) AND n.nspname=$2
          AND a.usename=$3`, [migrationPid, namespace, namespace === 'auth' ? 'supabase_auth_admin' : 'supabase_storage_admin'])
      if (rows.length) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  let uploaded = false
  try {
    const created = await request('/auth/v1/admin/users', { email, password, email_confirm: true })
    assert.equal(created.status, 200, 'create only this local synthetic Auth fixture')
    owner = (await created.json()).id
    const signedIn = await login(); assert.equal(signedIn.status, 200)
    token = (await signedIn.json()).access_token
    pointer = `${source}/${owner}/${randomUUID()}.txt`
    storagePath = '/storage/v1/object/workspace/' + pointer
    await db.query('BEGIN')
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES ($1,$2,'upgrade fixture','fixture','linux')", [device, owner])
    for (const agent of agents) await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES ($1,'agent','upgrade fixture agent',$2,$3)", [agent, owner, device])
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','upgrade concurrency',$2)", [source, owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner')", [source, owner])
    const anchor = randomUUID()
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'anchor')", [anchor, source, owner])
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id,source_message_id) VALUES ($1,'topic','upgrade concurrency',$2,$3,$4)", [topic, owner, source, anchor])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner')", [topic, owner])
    await db.query('COMMIT')
    const upload = await fetch(api.origin + storagePath, { method: 'POST', headers: { apikey: status.ANON_KEY, authorization: 'Bearer ' + token, 'content-type': 'text/plain' }, body: 'probe bytes', signal: AbortSignal.timeout(30_000) })
    assert.equal(upload.status, 200); await upload.body?.cancel(); uploaded = true

    await test('a busy writer aborts the whole upgrade with an explicit retry error', async () => {
      const writer = await writerOf()
      try {
        await writer.query('BEGIN'); await asOwner(writer)
        await writer.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'existing writer')", [randomUUID(), topic, owner])
        await assert.rejects(db.query(head), { code: '55P03', hint: 'topic_resources_lock_busy_retry' })
        await db.query('ROLLBACK')
        await writer.query('COMMIT')
        assert.equal((await db.query("SELECT prorettype::regtype::text AS type FROM pg_proc WHERE oid='chat.workspace_require_room_member(text,text)'::regprocedure")).rows[0].type, 'void')
      } finally { await db.query('ROLLBACK'); await writer.query('ROLLBACK'); await writer.end() }
    })

    async function run(phase, migrationFirst, agent) {
      const writer = await writerOf()
      const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      let loginPending, storagePending
      const holdStart = performance.now()
      try {
        await db.query(`SET deadlock_timeout='${migrationFirst ? '100ms' : '10s'}'`)
        await writer.query(`SET deadlock_timeout='${migrationFirst ? '10s' : '100ms'}'`)
        await db.query(head)
        if (phase === 'late') await db.query(body)
        await writer.query('BEGIN'); await asOwner(writer)
        await writer.query("SET LOCAL lock_timeout='30s'; SET LOCAL statement_timeout='30s'")
        const pending = writer.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'pooled writer during upgrade')", [randomUUID(), topic, agent])
        // Attach rejection handlers immediately; failures remain assertion errors.
        const outcome = pending.then(() => null, (error) => error)
        console.log('topic upgrade pooled writer waits:', phase, migrationFirst ? 'migration detector first' : 'writer detector first', await blocked(pid, pending))
        if (phase !== 'late') {
          await db.query(body)
          await db.query('ROLLBACK')
          assert.equal(await outcome, null, 'no writer or migration may be a deadlock victim')
          await writer.query('ROLLBACK')
          return
        }
        const loginStart = performance.now()
        loginPending = login(); loginPending.catch(() => {})
        const storageStart = performance.now()
        storagePending = fetch(api.origin + storagePath, { headers: { apikey: status.ANON_KEY, authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30_000) })
        storagePending.catch(() => {})
        await Promise.all([blockedHttp('auth', loginPending), blockedHttp('storage', storagePending)])
        await db.query('COMMIT')
        const holdMs = performance.now() - holdStart
        assert.equal(await outcome, null, 'the late pooled writer succeeds after the new trigger becomes visible')
        await writer.query('COMMIT')
        const authResponse = await loginPending, storageResponse = await storagePending
        assert.equal(authResponse.status, 200); await authResponse.body?.cancel()
        assert.equal(storageResponse.status, 200); assert.equal(await storageResponse.text(), 'probe bytes')
        console.log('topic upgrade observed maintenance window ms (includes lock-observation barriers):', JSON.stringify({ transaction: holdMs, login: performance.now() - loginStart, storage: performance.now() - storageStart }))
        assert.deepEqual((await db.query('SELECT chat.is_chat_member($1,$3) AS source,chat.is_chat_member($2,$3) AS topic', [source, topic, agent])).rows[0], { source: true, topic: true })
        await writer.query('BEGIN'); await asOwner(writer)
        assert.equal((await writer.query('SELECT total FROM chat.workspace_status_as($1,$2)', [topic, agent])).rows[0].total, 0)
        await writer.query('COMMIT')
      } finally {
        await db.query('ROLLBACK'); await db.query('RESET deadlock_timeout')
        await writer.query('ROLLBACK'); await writer.end()
        await Promise.allSettled([loginPending, storagePending].filter(Boolean))
      }
    }
    await test('a pooled writer after the lock boundary cannot be the deadlock victim', () => run('early', false, agents[0]))
    await test('the migration after the lock boundary cannot be the deadlock victim', () => run('early', true, agents[1]))
    await test('a late pooled topic writer waits, commits a source seat and can use files', () => run('late', false, agents[2]))
    const fresh = new pg.Client({ connectionString: database.href })
    await fresh.connect()
    try {
      await fresh.query('BEGIN'); await asOwner(fresh)
      await fresh.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'fresh connection positive control')", [randomUUID(), topic, agents[3]])
      await fresh.query('COMMIT')
      assert.deepEqual((await db.query('SELECT chat.is_chat_member($1,$3) AS source,chat.is_chat_member($2,$3) AS topic', [source, topic, agents[3]])).rows[0], { source: true, topic: true })
    } finally { await fresh.query('ROLLBACK'); await fresh.end() }
    return []
  } finally {
    await db.query('ROLLBACK')
    if (uploaded) {
      const removed = await request('/storage/v1/object/workspace', { prefixes: [pointer] }, token, 'DELETE')
      assert.equal(removed.status, 200); await removed.body?.cancel()
    }
    await db.query('DELETE FROM chat.chats WHERE id=$1', [source])
    await db.query('DELETE FROM identity.users WHERE id=ANY($1)', [agents])
    await db.query('DELETE FROM identity.gugu_devices WHERE device_id=$1', [device])
    if (owner) {
      const removed = await request('/auth/v1/admin/users/' + owner, undefined, status.SERVICE_ROLE_KEY, 'DELETE')
      assert.equal(removed.status, 200); await removed.body?.cancel()
    }
    await monitor.end()
  }
}
