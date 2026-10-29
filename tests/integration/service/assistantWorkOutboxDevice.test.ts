import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: pg.Client
let owner: string, stranger: string, assistant: string, executor: string, home: string, device: string
let instance: string, workerInstance: string, coordinator: string, worker: string, chat: string
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
type Event = { message_id: string; kind: string; from_session_id: string; from_device_id: string; to_session_id: string; to_device_id: string; content?: string; [key: string]: unknown }
type Work = { work_id: string; outcome: string; terminal_version: string }
type Delivery = Event & { seq:string; lease_token: string; delivery_state: string; platform_received_at: string; assistant_admitted_at: string | null; owner_delivered_at: string | null; occurred_at?:string }

async function as<T>(user: string, action: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  await db.query('SET LOCAL ROLE authenticated')
  try { return await action() } finally { await db.query('RESET ROLE').catch(() => undefined) }
}
async function call<T = Record<string, unknown>>(name: string, args: unknown[]): Promise<T> {
  return (await db.query<{ result: T }>(`SELECT identity.${name}(${args.map((_,i) => `$${i+1}`).join(',')}) AS result`, args)).rows[0]!.result
}
async function failure(action: () => Promise<unknown>, pattern: RegExp) {
  await db.query('SAVEPOINT expected_failure')
  try { await expect(action()).rejects.toThrow(pattern) } finally { await db.query('ROLLBACK TO SAVEPOINT expected_failure') }
}
const task = (executors = [{ session_id: worker, device_id: device, agent_user_id: executor }]) => ({ title: 'Check a result', coordinator_session_id: coordinator, executors })
const dispatch = (extra: Partial<Event> = {}): Event => ({ message_id: randomUUID(), kind: 'dispatch', from_session_id: coordinator, from_device_id: home, to_session_id: worker, to_device_id: device, content: 'Please check this result', ...extra })
const report = (kind = 'completed', extra: Partial<Event> = {}): Event => ({ message_id: randomUUID(), kind, from_session_id: worker, from_device_id: device, to_session_id: coordinator, to_device_id: home, content: 'Verified the result', ...extra })
const commit = (id: string, events: Event[], initial: unknown = null, op = randomUUID(), runtime = instance) => as(owner, () => call<Work>('assistant_work_commit', [assistant,runtime,op,id,initial === null ? null : JSON.stringify(initial),JSON.stringify(events)]))
const claim = (runtime = instance, limit = 20) => as(owner, () => call<{ events: Delivery[] }>('assistant_work_outbox_claim', [runtime,limit,60]))
const settle = (event: Delivery, stage = 'executor_admitted', runtime = instance, receipt = {}) => as(owner, () => call('assistant_work_outbox_settle', [runtime,event.message_id,event.lease_token,stage,stage === 'retry' ? 'CHANNEL_UNAVAILABLE' : null,5,JSON.stringify(receipt)]))

beforeAll(async () => {
  if (!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw new Error('Work ledger tests require a disposable loopback database')
  db = new pg.Client({ connectionString: url }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); stranger = randomUUID(); assistant = randomUUID(); executor = randomUUID()
  home = `ledger-${randomUUID()}`; device = `ledger-${randomUUID()}`
  instance = randomUUID(); workerInstance = randomUUID(); coordinator = randomUUID(); worker = randomUUID(); chat = randomUUID()
  for (const id of [owner,stranger]) {
    await db.query(`INSERT INTO auth.users(id,instance_id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
      confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
      VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}','','','','',now(),now())`,[id,`${id}@ledger.invalid`])
    await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Ledger test') ON CONFLICT DO NOTHING",[id])
  }
  for (const id of [home,device]) await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')",[id,owner])
  for (const [id,host] of [[assistant,home],[executor,device]]) await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Ledger agent',$2,$3)",[id,owner,host])
  await db.query("INSERT INTO chat.chats(id,kind,creator_user_id) VALUES($1,'dm',$2)",[chat,owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')",[chat,owner,assistant])
  const provision = randomUUID()
  await db.query("INSERT INTO identity.agent_provision_operations(id,owner_user_id,device_id,kind,payload_hash,blueprint,phase) VALUES($1,$2,$3,'single','fixture','{}','completed')",[provision,owner,home])
  await db.query(`INSERT INTO identity.agent_provisions(id,owner_user_id,operation_id,member_key,device_id,display_name,agent_type,inherit_memory,history_import_required,payload_hash,agent_user_id,provisioned_agent_user_id,dm_chat_id,phase)
    VALUES($1,$2,$3,'assistant',$4,'Ledger assistant','claude-code',false,false,'fixture',$5::text,$5::text::uuid,$6,'completed')`,[randomUUID(),owner,provision,home,assistant,chat])
  for (const [id,host] of [[instance,home],[workerInstance,device]]) await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[id,host,owner])
})
afterEach(async () => { await db.query('ROLLBACK') })

describe('assistant work belongs to its target device', () => {
  it.each(['dispatch', 'progress'])('protects an online %s target but permits delegation when its heartbeat is stale', async kind => {
    const id = randomUUID(), event = kind === 'dispatch' ? dispatch() : report('progress')
    await commit(id, [kind === 'dispatch' ? event : dispatch()], task())
    if (kind !== 'dispatch') {
      await db.query("UPDATE identity.assistant_work_events SET delivery_state='admitted',executor_admitted_at=now() WHERE work_id=$1", [id])
      await commit(id, [event], null, randomUUID(), workerInstance)
    }
    const proxy = kind === 'dispatch' ? instance : workerInstance
    const target = kind === 'dispatch' ? workerInstance : instance
    expect((await claim(proxy)).events).toHaveLength(0)
    await db.query("UPDATE identity.runtime_instances SET last_heartbeat_at=clock_timestamp()-interval '91 seconds' WHERE instance_id=$1", [target])
    const delegated = (await claim(proxy)).events
    expect(delegated.map(row => row.message_id)).toEqual([event.message_id])
    expect(delegated[0]).toHaveProperty('delivery_target', { device_id: event.to_device_id, session_id: event.to_session_id })
    await settle(delegated[0]!, kind === 'dispatch' ? 'executor_admitted' : 'assistant_admitted', proxy)
  })

  it.each(['dispatch', 'progress'])('cools an outdated %s delegate without delaying a target that comes online', async kind => {
    const id = randomUUID(), event = kind === 'dispatch' ? dispatch() : report('progress'), token = randomUUID()
    await commit(id, [kind === 'dispatch' ? event : dispatch()], task())
    if (kind !== 'dispatch') {
      await db.query("UPDATE identity.assistant_work_events SET delivery_state='admitted',executor_admitted_at=now() WHERE work_id=$1", [id])
      await commit(id, [event], null, randomUUID(), workerInstance)
    }
    const proxy = kind === 'dispatch' ? instance : workerInstance
    const target = kind === 'dispatch' ? workerInstance : instance
    await db.query("UPDATE identity.runtime_instances SET last_heartbeat_at=clock_timestamp()-interval '91 seconds' WHERE instance_id=$1", [target])
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='claimed',lease_instance_id=$1,lease_token=$2,lease_until=clock_timestamp()+interval '60 seconds' WHERE message_id=$3", [proxy, token, event.message_id])
    await as(owner, () => call('assistant_work_outbox_settle', [proxy, event.message_id, token, 'retry', 'CLIENT_OUTDATED', 1, '{"failure_observed":true}']))
    const row = (await db.query('SELECT failed_attempts,extract(epoch FROM (available_at-clock_timestamp())) AS wait FROM identity.assistant_work_events WHERE message_id=$1', [event.message_id])).rows[0]
    expect(row.failed_attempts).toBe(0)
    expect(Number(row.wait)).toBeGreaterThan(29)
    expect((await claim(proxy)).events).toHaveLength(0)
    expect((await claim(proxy)).events).toHaveLength(0)
    await db.query('UPDATE identity.runtime_instances SET last_heartbeat_at=clock_timestamp() WHERE instance_id=$1', [target])
    expect((await claim(target)).events.map(row => row.message_id)).toEqual([event.message_id])
  })

  it('bounds one expiry sweep to 100 rows and preserves the last real error', async () => {
    for (let index = 0; index < 101; index++) await commit(randomUUID(), [dispatch()], task())
    await db.query("UPDATE identity.assistant_work_events SET platform_received_at=clock_timestamp()-interval '25 hours',last_error_code='DELIVERY_HOST_OUTDATED' WHERE owner_user_id=$1", [owner])
    expect((await claim(workerInstance, 1)).events).toHaveLength(0)
    const rows = (await db.query('SELECT delivery_state,last_error_code,abandoned_reason_code FROM identity.assistant_work_events WHERE owner_user_id=$1', [owner])).rows
    expect(rows.filter(row => row.delivery_state === 'abandoned')).toHaveLength(100)
    expect(rows.filter(row => row.delivery_state === 'pending')).toHaveLength(1)
    expect(rows.every(row => row.last_error_code === 'DELIVERY_HOST_OUTDATED')).toBe(true)
    expect(rows.filter(row => row.delivery_state === 'abandoned').every(row => row.abandoned_reason_code === 'DELIVERY_EXPIRED')).toBe(true)
    expect((await claim(instance)).events).toHaveLength(0)
    expect(Number((await db.query("SELECT count(*) AS n FROM identity.assistant_work_events WHERE owner_user_id=$1 AND delivery_state='abandoned'", [owner])).rows[0].n)).toBe(101)
  })

  it('preserves the last real error separately from the expiry reason', async () => {
    const event = dispatch()
    await commit(randomUUID(), [event], task())
    await db.query("UPDATE identity.assistant_work_events SET platform_received_at=clock_timestamp()-interval '25 hours',last_error_code='DELIVERY_HOST_OUTDATED' WHERE message_id=$1", [event.message_id])
    expect((await claim()).events).toHaveLength(0)
    expect((await db.query('SELECT last_error_code,abandoned_reason_code FROM identity.assistant_work_events WHERE message_id=$1', [event.message_id])).rows[0]).toEqual({ last_error_code: 'DELIVERY_HOST_OUTDATED', abandoned_reason_code: 'DELIVERY_EXPIRED' })
  })

  it('two connections concurrently expire one row and broadcast one notice without leasing it', async () => {
    const event = dispatch()
    await commit(randomUUID(), [event], task())
    await db.query("UPDATE identity.assistant_work_events SET platform_received_at=clock_timestamp()-interval '25 hours' WHERE message_id=$1", [event.message_id])
    await db.query('COMMIT')
    const other = new pg.Client({ connectionString: url })
    await other.connect()
    const notices = async () => Number((await db.query("SELECT count(*) AS n FROM realtime.messages WHERE topic=$1 AND event='assistant_work_changed'", [`gugu:user:${owner}:events`])).rows[0].n)
    const before = await notices()
    async function prepare(client: pg.Client) {
      await client.query('BEGIN')
      await client.query("SET LOCAL statement_timeout='5s'")
      await client.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
      await client.query('SET LOCAL ROLE authenticated')
    }
    async function take(client: pg.Client, runtime: string) {
      try {
        const result = await client.query<{ result: { events: Delivery[] } }>('SELECT identity.assistant_work_outbox_claim($1,20,60) AS result', [runtime])
        await client.query('COMMIT')
        return result.rows[0]!.result.events
      } catch (error) { await client.query('ROLLBACK'); throw error }
    }
    try {
      await Promise.all([prepare(db), prepare(other)])
      const claimed = await Promise.all([take(db, instance), take(other, workerInstance)])
      expect(claimed.flat()).toHaveLength(0)
      expect(await notices()).toBe(before + 1)
      expect((await db.query('SELECT delivery_state,attempts,lease_token FROM identity.assistant_work_events WHERE message_id=$1', [event.message_id])).rows[0]).toEqual({ delivery_state: 'abandoned', attempts: 0, lease_token: null })
    } finally {
      await other.end()
      await db.query('ROLLBACK')
      await db.query('DELETE FROM identity.assistant_work WHERE owner_user_id=$1', [owner])
      await db.query('DELETE FROM identity.agent_provision_operations WHERE owner_user_id=$1', [owner])
      await db.query('DELETE FROM chat.chats WHERE id=$1', [chat])
      await db.query('DELETE FROM identity.users WHERE id=ANY($1)', [[assistant, executor]])
      await db.query('DELETE FROM identity.gugu_devices WHERE device_id=ANY($1)', [[home, device]])
      await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [[owner, stranger]])
      await db.query('BEGIN')
    }
  })

  it('expires an offline target on another device claim and records one verified owner notice', async () => {
    const id = randomUUID(), event = dispatch()
    await commit(id, [event], task())
    await db.query('UPDATE identity.gugu_devices SET label=$1,label_customized_at=clock_timestamp() WHERE device_id=$2', ['离线测试电脑', device])
    await db.query("UPDATE identity.runtime_instances SET last_heartbeat_at=now()-interval '25 hours' WHERE instance_id=$1", [workerInstance])
    await db.query("UPDATE identity.assistant_work_events SET platform_received_at=clock_timestamp()-interval '24 hours',available_at=clock_timestamp()+interval '5 minutes' WHERE message_id=$1", [event.message_id])
    const notices = async () => Number((await db.query("SELECT count(*) AS n FROM realtime.messages WHERE topic=$1 AND event='assistant_work_changed'", [`gugu:user:${owner}:events`])).rows[0].n)
    const before = await notices()
    expect((await claim()).events).toHaveLength(0)
    const row = (await db.query('SELECT delivery_state,abandoned_reason_code,lease_token,lease_instance_id,attempts,failed_attempts,executor_admitted_at,owner_delivered_at FROM identity.assistant_work_events WHERE message_id=$1', [event.message_id])).rows[0]
    expect(row).toEqual({ delivery_state: 'abandoned', abandoned_reason_code: 'DELIVERY_EXPIRED', lease_token: null, lease_instance_id: null, attempts: 0, failed_attempts: 0, executor_admitted_at: null, owner_delivered_at: null })
    expect(await notices()).toBe(before + 1)
    expect((await claim()).events).toHaveLength(0)
    expect(await notices()).toBe(before + 1)
    const abandoned = () => as(owner, () => call<{ events: Delivery[] }>('assistant_work_abandoned', [instance, 100]))
    expect((await abandoned()).events).toEqual([expect.objectContaining({ message_id: event.message_id, to_device_id: device, to_device_label: '离线测试电脑', abandoned_reason_code: 'DELIVERY_EXPIRED' })])
    const notice = randomUUID()
    await failure(() => as(owner, () => call('assistant_work_owner_delivered', [assistant, instance, event.message_id, chat, notice, 'abandonment_notice'])), /message|source|not found/i)
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,$4,'text')", [notice, chat, assistant, `发给 ${device} 设备的活没送到`])
    for (let retry = 0; retry < 2; retry++) await as(owner, () => call('assistant_work_owner_delivered', [assistant, instance, event.message_id, chat, notice, 'abandonment_notice']))
    expect((await abandoned()).events).toHaveLength(0)
    expect((await db.query('SELECT count(*)::int AS n FROM chat.messages WHERE chat_id=$1 AND sender_user_id=$2', [chat, assistant])).rows[0].n).toBe(1)
  })

  it('expires stale leases but preserves young work, active leases, admissions and other accounts', async () => {
    const stale = dispatch(), active = dispatch(), admitted = dispatch(), young = dispatch()
    for (const event of [stale, active, admitted, young]) await commit(randomUUID(), [event], task())
    await db.query("UPDATE identity.assistant_work_events SET platform_received_at=clock_timestamp()-interval '25 hours' WHERE message_id=ANY($1::uuid[])", [[stale.message_id, active.message_id, admitted.message_id]])
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='claimed',lease_token=gen_random_uuid(),lease_instance_id=$1,lease_until=clock_timestamp()+CASE WHEN message_id=$2 THEN interval '-1 second' ELSE interval '30 seconds' END WHERE message_id=ANY($3::uuid[])", [workerInstance, stale.message_id, [stale.message_id, active.message_id]])
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='admitted',executor_admitted_at=now() WHERE message_id=$1", [admitted.message_id])
    await db.query("UPDATE identity.assistant_work_events SET platform_received_at=clock_timestamp()-interval '23 hours' WHERE message_id=$1", [young.message_id])
    // A different authenticated account must not sweep this owner's old work.
    const otherDevice = `ledger-${randomUUID()}`, otherRuntime = randomUUID()
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')", [otherDevice, stranger])
    await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)', [otherRuntime, otherDevice, stranger])
    expect((await as(stranger, () => call<{events: Delivery[]}>('assistant_work_outbox_claim', [otherRuntime, 20, 60]))).events).toHaveLength(0)
    expect((await db.query('SELECT delivery_state FROM identity.assistant_work_events WHERE message_id=$1', [stale.message_id])).rows[0].delivery_state).toBe('claimed')
    expect((await claim()).events).toHaveLength(0)
    const states = (await db.query('SELECT message_id,delivery_state,lease_token FROM identity.assistant_work_events WHERE owner_user_id=$1', [owner])).rows
    expect(states.find(row => row.message_id === stale.message_id)).toMatchObject({ delivery_state: 'abandoned', lease_token: null })
    expect(states.find(row => row.message_id === active.message_id)).toMatchObject({ delivery_state: 'claimed', lease_token: expect.any(String) })
    expect(states.find(row => row.message_id === admitted.message_id)).toHaveProperty('delivery_state', 'admitted')
    expect(states.find(row => row.message_id === young.message_id)).toHaveProperty('delivery_state', 'pending')
    expect((await claim(workerInstance)).events.map(row => row.message_id)).toEqual([young.message_id])
  })

  it('upgrade releases old foreign leases and incompatible backoff without changing valid leases or history', async () => {
    const pending = dispatch(), foreign = dispatch(), valid = dispatch(), rejected = dispatch()
    for (const event of [pending, foreign, valid, rejected]) await commit(randomUUID(), [event], task())
    const oldToken = randomUUID(), validToken = randomUUID()
    await db.query("UPDATE identity.assistant_work_events SET last_error_code='CLIENT_OUTDATED',failed_attempts=8,available_at=clock_timestamp()+interval '5 minutes' WHERE message_id=$1", [pending.message_id])
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='claimed',lease_instance_id=$1,lease_token=$2,lease_until=clock_timestamp()+interval '60 seconds',attempts=1 WHERE message_id=$3", [instance, oldToken, foreign.message_id])
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='claimed',lease_instance_id=$1,lease_token=$2,lease_until=clock_timestamp()+interval '60 seconds',attempts=1 WHERE message_id=$3", [workerInstance, validToken, valid.message_id])
    await db.query("UPDATE identity.assistant_work_events SET last_error_code='DELIVERY_HOST_OUTDATED',failed_attempts=1,available_at=clock_timestamp()+interval '5 minutes' WHERE message_id=$1", [rejected.message_id])
    const offlineDevice = `ledger-${randomUUID()}`, offlineSession = randomUUID(), delegatedToken = randomUUID()
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')", [offlineDevice, owner])
    const delegated = dispatch({ to_session_id: offlineSession, to_device_id: offlineDevice })
    await commit(randomUUID(), [delegated], task([{ session_id: offlineSession, device_id: offlineDevice }] as never))
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='claimed',lease_instance_id=$1,lease_token=$2,lease_until=clock_timestamp()+interval '60 seconds' WHERE message_id=$3", [instance, delegatedToken, delegated.message_id])
    const body = readFileSync(new URL('../../../supabase/migrations/20261029161000_assistant_work_target_device_claim.sql', import.meta.url), 'utf8')
    const notices = async () => Number((await db.query("SELECT count(*) AS n FROM realtime.messages WHERE topic=$1 AND event='assistant_work_changed'", [`gugu:user:${owner}:events`])).rows[0].n)
    const before = await notices()
    await db.query(body)
    expect.soft(await notices()).toBe(before + 1)
    const rows = (await db.query('SELECT message_id,delivery_state,lease_token,failed_attempts,available_at<=clock_timestamp() AS ready FROM identity.assistant_work_events WHERE owner_user_id=$1 ORDER BY seq', [owner])).rows
    expect(rows.find(row => row.message_id === pending.message_id)).toMatchObject({ delivery_state: 'pending', failed_attempts: 8, ready: true })
    expect(rows.find(row => row.message_id === foreign.message_id)).toMatchObject({ delivery_state: 'pending', lease_token: null })
    expect(rows.find(row => row.message_id === valid.message_id)).toMatchObject({ delivery_state: 'claimed', lease_token: validToken })
    expect(rows.find(row => row.message_id === rejected.message_id)).toMatchObject({ failed_attempts: 1, ready: false })
    expect(rows.find(row => row.message_id === delegated.message_id)).toMatchObject({ delivery_state: 'claimed', lease_token: delegatedToken })
    await failure(() => as(owner, () => call('assistant_work_outbox_settle', [instance, foreign.message_id, oldToken, 'retry', 'CLIENT_OUTDATED', 300, '{}'])), /lease|token/)
    expect((await claim(workerInstance)).events.map(row => row.message_id)).toEqual([pending.message_id, foreign.message_id])
  })

  it('an older runtime cannot steal and delay the target device dispatch', async () => {
    const id = randomUUID(), event = dispatch()
    await commit(id, [event], task())
    const old = (await claim(instance)).events
    // This is the deployed old client's settlement shape after the target rejects its RPC version.
    if (old[0]) await as(owner, () => call('assistant_work_outbox_settle', [instance, event.message_id,
      old[0].lease_token, 'retry', 'CLIENT_OUTDATED', 300, JSON.stringify({ failure_observed: true })]))
    const intended = (await claim(workerInstance)).events
    expect.soft(old).toHaveLength(0)
    expect.soft(intended.map(row => row.message_id)).toEqual([event.message_id])
    expect((await db.query('SELECT failed_attempts FROM identity.assistant_work_events WHERE message_id=$1', [event.message_id])).rows[0].failed_attempts).toBe(0)
  })

  it('reports are claimed by the current coordinator device rather than an executor runtime', async () => {
    const id = randomUUID(), event = report('progress')
    await commit(id, [dispatch()], task())
    await settle((await claim(workerInstance)).events[0]!, 'executor_admitted', workerInstance)
    await commit(id, [event], null, randomUUID(), workerInstance)
    expect((await claim(workerInstance)).events).toHaveLength(0)
    const ready = (await claim(instance)).events
    expect(ready.map(row => row.message_id)).toEqual([event.message_id])
    await settle(ready[0]!, 'assistant_admitted', instance)
  })

  it('a deployed incompatible lease cools foreign delivery while its live target claims immediately', async () => {
    const id = randomUUID(), event = dispatch(), token = randomUUID()
    await commit(id, [event], task())
    // Reproduce a lease issued before the routing fix, without requiring new client arguments.
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='claimed',lease_instance_id=$1,lease_token=$2,lease_until=clock_timestamp()+interval '60 seconds',attempts=1 WHERE message_id=$3", [instance, token, event.message_id])
    const before = Number((await db.query("SELECT count(*) AS n FROM realtime.messages WHERE topic=$1 AND event='assistant_work_changed'", [`gugu:user:${owner}:events`])).rows[0].n)
    await as(owner, () => call('assistant_work_outbox_settle', [instance, event.message_id, token,
      'retry', 'CLIENT_OUTDATED', 300, JSON.stringify({ failure_observed: true })]))
    expect.soft(Number((await db.query("SELECT count(*) AS n FROM realtime.messages WHERE topic=$1 AND event='assistant_work_changed'", [`gugu:user:${owner}:events`])).rows[0].n)).toBe(before + 1)
    const row = (await db.query('SELECT failed_attempts,available_at<=clock_timestamp() AS ready FROM identity.assistant_work_events WHERE message_id=$1', [event.message_id])).rows[0]
    expect.soft(row).toEqual({ failed_attempts: 0, ready: false })
    expect((await claim(workerInstance)).events.map(row => row.message_id)).toEqual([event.message_id])
  })

  it('a real target-host incompatibility retains its failure and retry delay', async () => {
    const id = randomUUID(), event = dispatch()
    await commit(id, [event], task())
    const leased = (await claim(workerInstance)).events[0]!
    await as(owner, () => call('assistant_work_outbox_settle', [workerInstance, event.message_id, leased.lease_token,
      'retry', 'DELIVERY_HOST_OUTDATED', 300, JSON.stringify({ failure_observed: true })]))
    expect((await db.query('SELECT failed_attempts,available_at>clock_timestamp() AS delayed FROM identity.assistant_work_events WHERE message_id=$1', [event.message_id])).rows[0]).toEqual({ failed_attempts: 1, delayed: true })
    expect((await claim(workerInstance)).events).toHaveLength(0)
  })

  it('a wrong or expired runtime still cannot claim on behalf of the target', async () => {
    await commit(randomUUID(), [dispatch()], task())
    await failure(() => as(stranger, () => call('assistant_work_outbox_claim', [workerInstance, 20, 60])), /runtime lease/)
    await db.query("UPDATE identity.runtime_instances SET last_heartbeat_at=now()-interval '2 minutes' WHERE instance_id=$1", [workerInstance])
    await failure(() => claim(workerInstance), /runtime lease/)
  })
})
