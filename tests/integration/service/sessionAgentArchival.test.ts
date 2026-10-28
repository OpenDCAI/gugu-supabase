import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: Client
let owner: string, outsider: string, agent: string, peer: string, device: string, group: string
let interval: string
let archivedAt: string, restoredAt: string

async function asUser(id = owner) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}

async function lifecycle(revision: number, archived: string | null, intervals: unknown[], operation = randomUUID(), account = owner, host = device) {
  await asUser(account)
  const { rows } = await db.query(`SELECT identity.set_agent_session_archival($1,$2,$3,$4,$5,$6) AS receipt`,
    [agent, host, operation, revision, archived, JSON.stringify(intervals)])
  await db.query('RESET ROLE')
  return rows[0].receipt
}

function range(closed = false) {
  return { id: interval, archived_at: archivedAt, restored_at: closed ? restoredAt : null }
}

async function archive() { return lifecycle(1, archivedAt, [range()]) }
async function restore() { return lifecycle(2, null, [range(true)]) }

async function denied(action: () => Promise<unknown>) {
  await db.query('SAVEPOINT denied')
  try { await action() } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT denied')
    await db.query('RESET ROLE')
    return (error as Error).message
  }
  throw new Error('Expected archival operation to fail')
}

async function send(to = [agent], options: { at?: string; whisper?: boolean; chat?: string; sender?: string } = {}) {
  const id = randomUUID()
  await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,to_user_ids,created_at,is_whisper)
    VALUES($1,$2,$3,'Archive fixture message',$4,$5,$6)`,
  [id, options.chat ?? group, options.sender ?? owner, to, options.at ?? restoredAt, options.whisper ?? false])
  return id
}

async function pull(target = agent) {
  await asUser()
  const result = await db.query('SELECT id FROM identity.pull_agent_inbox_v2($1) ORDER BY seq', [target])
  await db.query('RESET ROLE')
  return result.rows.map(({ id }) => id)
}

async function facts(message: string, target = agent) {
  const { rows } = await db.query(`SELECT
    EXISTS(SELECT 1 FROM chat.message_agent_wakes WHERE message_id=$1 AND agent_user_id=$2) AS wake,
    EXISTS(SELECT 1 FROM chat.message_agent_delivery_blocks WHERE message_id=$1 AND agent_user_id=$2) AS blocked,
    EXISTS(SELECT 1 FROM identity.gugu_device_commands WHERE payload->>'message_id'=$1 AND payload->>'agent_user_id'=$2) AS command,
    EXISTS(SELECT 1 FROM chat.message_deliveries WHERE message_id=$1 AND device_id='gugu-agent:'||$2) AS receipt`, [message, target])
  return rows[0]
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Session archival requires the disposable loopback database')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, outsider, agent, peer, device, group, interval] = Array.from({ length: 7 }, randomUUID)
  archivedAt = new Date(Date.now() - 20_000).toISOString()
  restoredAt = new Date(Date.now() - 10_000).toISOString()
  for (const id of [owner, outsider]) {
    await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [id, `${id}@session-archive.invalid`])
  }
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'Archive fixture','Archive fixture','darwin')`, [device, owner])
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,desired_status)
    VALUES($1,'agent','Claude 1',$3,$4,'online'),($2,'agent','Active peer',$3,$4,'online')`, [agent, peer, owner, device])
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Archive fixture',$2)`, [group, owner])
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role,listen_mode)
    VALUES($1,$2,'owner','passive'),($1,$3,'member','passive'),($1,$4,'member','passive'),($1,$5,'member','passive')`,
  [group, owner, outsider, agent, peer])
})
afterEach(async () => {
  await db.query('ROLLBACK')
})

describe('reversible agent session archival', () => {
  it('retains the same identity, name, seats and historical sender through archive and restore', async () => {
    const authored = await send([], { sender: agent })
    const before = await db.query('SELECT * FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id', [group])
    const identity = (await db.query('SELECT id,display_name,gugu_number FROM identity.users WHERE id=$1', [agent])).rows
    await archive()
    expect((await db.query('SELECT * FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id', [group])).rows).toEqual(before.rows)
    await restore()
    expect((await db.query('SELECT id,display_name,gugu_number FROM identity.users WHERE id=$1', [agent])).rows).toEqual(identity)
    expect((await db.query('SELECT * FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id', [group])).rows).toEqual(before.rows)
    expect((await db.query('SELECT sender_user_id FROM chat.messages WHERE id=$1', [authored])).rows[0].sender_user_id).toBe(agent)
    expect((await db.query('SELECT * FROM identity.agent_lifecycle_tombstones WHERE agent_user_id=$1', [agent])).rows).toHaveLength(0)
  })

  it('still creates a distinct identity and serial name for a genuinely new session', async () => {
    await archive()
    await asUser()
    const fresh = randomUUID()
    const minted = (await db.query(`SELECT * FROM identity.provision_taskpage_agent($1,'Claude 1','serial','claude-code',$2)`, [fresh, device])).rows[0]
    await db.query('RESET ROLE')
    expect(minted.agent_id).toBe(fresh)
    expect(minted.agent_id).not.toBe(agent)
    expect(minted.display_name).not.toBe('Claude 1')
    expect((await db.query('SELECT display_name FROM identity.users WHERE id=$1', [agent])).rows[0].display_name).toBe('Claude 1')
  })

  it('refuses a group mention during archival without waking and delivers to an active peer', async () => {
    await archive()
    const message = await send([agent, peer], { at: archivedAt })
    expect(await facts(message)).toEqual({ wake: false, blocked: true, command: false, receipt: false })
    expect(await facts(message, peer)).toEqual({ wake: true, blocked: false, command: true, receipt: false })
    expect(await pull()).toEqual([])
    expect(await pull(peer)).toContain(message)
    await restore()
    expect(await pull()).toEqual([])
    const fresh = await send()
    expect(await pull()).toEqual([fresh])
    expect(await facts(fresh)).toEqual({ wake: true, blocked: false, command: true, receipt: false })
  })

  it('preserves DM history while refusing wake and delivery during archival', async () => {
    const dm = randomUUID()
    await db.query("INSERT INTO chat.chats(id,kind) VALUES($1,'dm')", [dm])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [dm, owner, agent])
    await archive()
    const message = await send([], { chat: dm, at: archivedAt })
    expect(await facts(message)).toEqual({ wake: false, blocked: true, command: false, receipt: false })
    await restore()
    expect(await pull()).toEqual([])
    await asUser()
    expect((await db.query('SELECT id FROM chat.messages WHERE id=$1', [message])).rows).toEqual([{ id: message }])
  })

  it('cuts off offline archive intervals without skipping pre-archive or post-restore messages', async () => {
    const earlier = await send([agent], { at: new Date(Date.parse(archivedAt) - 1).toISOString() })
    const start = await send([agent], { at: archivedAt })
    const during = await send([agent], { at: new Date(Date.parse(restoredAt) - 1).toISOString() })
    const after = await send([agent], { at: restoredAt })
    // The host archived and restored offline, then uploads the closed interval.
    await lifecycle(2, null, [range(true)])
    expect(await pull()).toEqual([earlier, after])
    expect((await facts(start)).blocked).toBe(true)
    expect((await facts(during)).blocked).toBe(true)
    expect((await facts(earlier)).blocked).toBe(false)
    expect((await facts(after)).blocked).toBe(false)
    expect((await db.query('SELECT count(*)::int AS n FROM chat.message_deliveries WHERE message_id=ANY($1)', [[start, during]])).rows[0].n).toBe(0)
  })

  it('makes retries idempotent and rejects stale revisions or changed operation payloads', async () => {
    const operation = randomUUID()
    const first = await lifecycle(1, archivedAt, [range()], operation)
    expect(await lifecycle(1, archivedAt, [range()], operation)).toEqual(first)
    expect(await denied(() => lifecycle(1, null, [], operation))).toContain('payload changed')
    await restore()
    expect(await denied(() => lifecycle(1, archivedAt, [range()]))).toContain('Stale')
    expect(await denied(() => lifecycle(3, null, [{ ...range(true), archived_at: restoredAt }]))).toContain('cannot change')
    expect((await db.query('SELECT session_archived_at FROM identity.users WHERE id=$1', [agent])).rows[0].session_archived_at).toBeNull()
  })

  it('cannot leave an open interval after restore or archive without an open interval', async () => {
    expect(await denied(() => lifecycle(1, archivedAt, []))).toContain('do not match')
    await archive()
    expect(await denied(() => lifecycle(2, null, []))).toContain('do not match')
  })

  it('denies other owners, wrong devices, anonymous calls and direct state writes', async () => {
    expect(await denied(() => lifecycle(1, archivedAt, [range()], randomUUID(), outsider))).toContain('not owned')
    expect(await denied(() => lifecycle(1, archivedAt, [range()], randomUUID(), owner, randomUUID()))).toContain('device does not match')
    expect(await denied(async () => { await asUser(); await db.query('UPDATE identity.users SET session_archived_at=now() WHERE id=$1', [agent]) })).toContain('permission denied')
    expect((await db.query("SELECT has_function_privilege('anon','identity.set_agent_session_archival(text,text,uuid,bigint,timestamp with time zone,jsonb)','execute') AS allowed")).rows[0].allowed).toBe(false)
    expect(await denied(async () => {
      await db.query("SELECT set_config('request.jwt.claims','{}',true)")
      await db.query('SELECT identity.set_agent_session_archival($1,$2,$3,1,$4,$5)', [agent, device, randomUUID(), archivedAt, JSON.stringify([range()])])
    })).toContain('Not authenticated')
  })

  it('exposes the archived state through presence, snapshot and durable display revisions', async () => {
    await archive()
    const presence = (await db.query('SELECT identity.build_agent_presence_payload($1) AS payload', [agent])).rows[0].payload
    expect(presence.presence.session_archived_at).not.toBeNull()
    expect(presence.presence.session_lifecycle_revision).toBe(1)
    await asUser()
    const snapshot = (await db.query('SELECT chat.sync_snapshot() AS snapshot')).rows[0].snapshot
    expect(snapshot.identities.find((item: { id: string }) => item.id === agent)).toEqual(expect.objectContaining({ session_lifecycle_revision: 1, session_archived_at: expect.any(String) }))
    await db.query('RESET ROLE')
    expect((await db.query("SELECT * FROM chat.account_revisions WHERE user_id=$1 AND event='agent_changed' AND resource_key->>'agent_user_id'=$2", [outsider, agent])).rows.length).toBeGreaterThan(0)
  })

  it('reports a terminal archived refusal to visible senders without leaking whisper facts', async () => {
    await archive()
    const message = await send([agent], { at: archivedAt, whisper: true })
    await asUser()
    expect((await db.query('SELECT reason FROM chat.message_agent_delivery_blocks WHERE message_id=$1', [message])).rows).toEqual([{ reason: 'agent_archived' }])
    await db.query('RESET ROLE')
    await asUser(outsider)
    expect((await db.query('SELECT * FROM chat.message_agent_delivery_blocks WHERE message_id=$1', [message])).rows).toHaveLength(0)
    await db.query('RESET ROLE')
    expect((await db.query("SELECT * FROM chat.account_revisions WHERE user_id=$1 AND event='delivery_changed' AND resource_key->>'entity_id'=$2", [owner, message])).rows.length).toBeGreaterThan(0)
    expect((await db.query("SELECT * FROM chat.account_revisions WHERE user_id=$1 AND event='delivery_changed' AND resource_key->>'entity_id'=$2", [outsider, message])).rows).toHaveLength(0)
  })

  it('refuses an already queued command after an offline interval is synchronized', async () => {
    const message = await send([agent], { at: archivedAt })
    const claim = randomUUID()
    const command = (await db.query(`UPDATE identity.gugu_device_commands SET status='running',claim_token=$2
      WHERE payload->>'message_id'=$1 AND payload->>'agent_user_id'=$3 RETURNING id`, [message, claim, agent])).rows[0].id
    await lifecycle(2, null, [range(true)])
    await asUser()
    expect((await db.query('SELECT identity.recheck_device_command_execution($1,$2) AS allowed', [command, claim])).rows[0].allowed).toBe(false)
    await db.query('RESET ROLE')
    expect(await denied(async () => {
      await asUser()
      // Internal helper stays closed to API roles; exercise its authorization
      // body as the database owner while retaining the authenticated JWT claims.
      await db.query('RESET ROLE')
      await db.query('SELECT identity.assert_device_command_post_context($1,$2,$3,$4)', [command, claim, agent, group])
    })).toContain('agent_archived')
  })

  it.each(['archive-first', 'send-first'])('settles a concurrent send and archive without an execution gap (%s)', async (order) => {
    // Only this suite's disposable fixture is committed, to make it visible to
    // the second transaction. The fixture is discarded with the owned database.
    await db.query('COMMIT')
    const sender = new Client({ connectionString: process.env.GUGU_INTEGRATION_DATABASE_URL })
    await sender.connect()
    const pid = (await sender.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const ownPid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const message = randomUUID()
    let pending: Promise<unknown> | undefined
    // A busy connection cannot inspect its own wait. Observe the lock rather
    // than relying on a sleep to prove that the transactions overlapped.
    const observer = new Client({ connectionString: process.env.GUGU_INTEGRATION_DATABASE_URL })
    await observer.connect()
    const waitForLock = async (blockedPid: number) => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        if ((await observer.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [blockedPid])).rows[0]?.waiting) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('Concurrent archival fixture did not reach its lock barrier')
    }
    try {
      await db.query("BEGIN; SET LOCAL statement_timeout='8s'")
      await sender.query("BEGIN; SET LOCAL statement_timeout='8s'")
      const insert = () => sender.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,to_user_ids,created_at)
        VALUES($1,$2,$3,'Concurrent archive mention',$4,$5)`, [message, group, owner, [agent], archivedAt])
      if (order === 'archive-first') {
        await archive()
        pending = insert()
        await waitForLock(pid)
        await db.query('COMMIT')
        await pending
        await sender.query('COMMIT')
        await db.query('BEGIN')
      } else {
        await insert()
        pending = archive()
        await waitForLock(ownPid)
        await sender.query('COMMIT')
        await pending
      }
      expect((await facts(message)).blocked).toBe(true)
      expect(await pull()).toEqual([])
      await restore()
      expect(await pull()).toEqual([])
      const fresh = await send()
      expect(await pull()).toEqual([fresh])
    } finally {
      await sender.query('ROLLBACK').catch(() => {})
      await pending?.catch(() => {})
      await sender.end()
      await observer.end()
    }
  })
})
