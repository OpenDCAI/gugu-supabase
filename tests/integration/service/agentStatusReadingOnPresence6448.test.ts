/** #6448 agent 状态读数上云:presence 行带上宿主写下的读数(基础态 + 附属态)。
 * 判据:① 读数经 set_agent_runtime_state 落两列、进 presence 载荷;② 只改读数的写也发 presence_changed
 * (广播触发器的「没变就不播」比对含这两列);③ 说不出读数的写把两列清空(❌ 留旧话);④ CHECK 拒绝不配对的读数;
 * ⑤ 改签名后只剩一个重载。只连 loopback 库,每个用例用自己的 agent。
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
    throw new Error('agentStatusReadingOnPresence6448 requires disposable loopback PostgreSQL')
  }
  db = new PgClient({ connectionString: url })
  await db.connect()
  await db.query("SET statement_timeout='10s'")
})
afterAll(async () => { await db?.end() })

interface Fixture { owner: string; agent: string; device: string }
async function fixture(body: (f: Fixture) => Promise<void>): Promise<void> {
  const f: Fixture = { owner: randomUUID(), agent: randomUUID(), device: `reading-6448-${randomUUID()}` }
  try {
    await db.query('INSERT INTO auth.users(id,email) VALUES ($1::uuid,$2)', [f.owner, `reading-${f.owner}@example.test`])
    await db.query("INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human','6448 owner') ON CONFLICT (id) DO NOTHING", [f.owner])
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,status) VALUES ($1,$2,'6448','isolated','linux','online')", [f.device, f.owner])
    await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,desired_status) VALUES ($1,'agent','6448 agent',$2,$3,'online')", [f.agent, f.owner, f.device])
    await body(f)
  } finally {
    await db.query('ROLLBACK').catch(() => undefined)
    await db.query('DELETE FROM identity.agent_runtime_states WHERE agent_user_id=$1', [f.agent])
    await db.query('DELETE FROM identity.users WHERE id=$1', [f.agent])
    await db.query('DELETE FROM identity.gugu_devices WHERE device_id=$1', [f.device])
    // 删 auth 账号要求那个 human 身份还在(erase_human_account 自己连带清掉 identity 行)。
    await db.query('DELETE FROM auth.users WHERE id=$1::uuid', [f.owner])
    await db.query('DELETE FROM chat.account_revision_heads WHERE user_id=$1', [f.owner])
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
  p_agent_user_id => $1, p_runtime_status => 'online', p_activity_status => $2,
  p_agent_status => $3, p_agent_status_detail => $4)`

async function presence(agent: string): Promise<Record<string, unknown>> {
  const rows = await db.query<{ payload: { presence: Record<string, unknown> } }>(
    'SELECT identity.build_agent_presence_payload($1) AS payload', [agent])
  return rows.rows[0]!.payload.presence
}
async function presenceRevisions(owner: string): Promise<number> {
  const rows = await db.query<{ count: string }>(
    "SELECT count(*) FROM chat.account_revisions WHERE user_id=$1 AND event='presence_changed'", [owner])
  return Number(rows.rows[0]!.count)
}

describe('#6448 presence 行带上宿主写下的读数', () => {
  it('读数落两列、进 presence 载荷;running/idle 投影照旧', async () => fixture(async (f) => {
    await asOwner(f.owner, WRITE, [f.agent, 'running', 'needs_user', 'approval'])
    expect(await presence(f.agent)).toMatchObject({
      activity_status: 'running',
      agent_status: 'needs_user',
      agent_status_detail: 'approval',
    })
  }))

  it('只改读数的写(投影不变)也发 presence_changed —— 别的设备才看得到从「在跑」变成「等你」', async () => fixture(async (f) => {
    await asOwner(f.owner, WRITE, [f.agent, 'running', 'working', 'running'])
    const before = await presenceRevisions(f.owner)
    await asOwner(f.owner, WRITE, [f.agent, 'running', 'needs_user', 'question'])
    expect(await presenceRevisions(f.owner)).toBeGreaterThan(before)
    // 阴控:同一句话再写一遍(只动 last_seen_at)不播。
    const settled = await presenceRevisions(f.owner)
    await asOwner(f.owner, WRITE, [f.agent, 'running', 'needs_user', 'question'])
    expect(await presenceRevisions(f.owner)).toBe(settled)
  }))

  it('说不出读数的写把两列清空,❌ 留着上一句', async () => fixture(async (f) => {
    await asOwner(f.owner, WRITE, [f.agent, 'running', 'working', 'parked'])
    await asOwner(f.owner, "SELECT identity.set_agent_runtime_state(p_agent_user_id => $1, p_runtime_status => 'offline', p_activity_status => 'idle')", [f.agent])
    expect(await presence(f.agent)).toMatchObject({ activity_status: 'idle', agent_status: null, agent_status_detail: null })
  }))

  it('CHECK 只放行配对的读数:附属态必须属于它的基础态,出错没有附属态', async () => fixture(async (f) => {
    for (const [status, detail] of [['idle', 'approval'], ['error', 'done'], ['working', null], [null, 'running'], ['online', null]] as const) {
      if (status === 'working') {
        // working 不带附属态是合法的(某家量不到附属态):阳控。
        await asOwner(f.owner, WRITE, [f.agent, 'running', status, detail])
        continue
      }
      await expect(asOwner(f.owner, WRITE, [f.agent, 'idle', status, detail]), `${status}/${detail}`)
        .rejects.toMatchObject({ code: '23514' })
    }
  }))

  it('只有一个 set_agent_runtime_state:两参的老调用照样解析(不产生重载歧义)', async () => fixture(async (f) => {
    await asOwner(f.owner, WRITE, [f.agent, 'running', 'working', 'running'])
    await asOwner(f.owner, 'SELECT identity.set_agent_runtime_state($1,$2)', [f.agent, 'offline'])
    const overloads = await db.query<{ count: string }>(
      "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='identity' AND p.proname='set_agent_runtime_state'")
    expect(Number(overloads.rows[0]!.count)).toBe(1)
    expect(await presence(f.agent)).toMatchObject({ agent_status: null, agent_status_detail: null })
  }))
})
