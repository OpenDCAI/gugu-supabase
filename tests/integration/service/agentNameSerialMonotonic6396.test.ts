import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * nmhjklnm/gugu#6396:agent 默认序号只增不减。
 *
 * 旧规则「同类型现存数量 + 1」会把删掉的号重新发出去(owner 名下已有 Claude 28,新会话叫 Claude 18)。
 * 新规则:每个账号、每个名字前缀记一个「用过的最大号」,serial 模式从它 + 1 起号,原子占号。
 *
 * 跑法:loopback `GUGU_INTEGRATION_DATABASE_URL`(跑过全部迁移的库)。单连接用例 BEGIN…ROLLBACK;
 * 并发那条要两个事务真提交,用独立的 owner,afterAll 删干净。
 */

interface QueryResult<Row> { rows: Row[] }
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>
}

const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}

const DATABASE_URL = (
  process.env.GUGU_INTEGRATION_DATABASE_URL
  ?? process.env.GUGU_DATABASE_URL
  ?? ''
).trim()

const OWNER = '63960000-0000-4000-8000-000000000001'
const OTHER_OWNER = '63960000-0000-4000-8000-000000000002'
const DEVICE = 'dev-it-6396'
const OTHER_DEVICE = 'dev-it-6396-other'
const RACE_OWNER = '63960000-0000-4000-8000-0000000000aa'
const RACE_DEVICE = 'dev-it-6396-race'

let database: DatabaseClient

function requireLoopbackDatabase(): void {
  let parsed: URL
  try {
    parsed = new URL(DATABASE_URL)
  } catch {
    throw new Error('GUGU_INTEGRATION_DATABASE_URL is required')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`agentNameSerialMonotonic6396.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`agentNameSerialMonotonic6396.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
}

beforeAll(async () => {
  requireLoopbackDatabase()
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})

afterAll(async () => {
  if (database) {
    await database.query('DELETE FROM identity.agent_profiles WHERE owner_id = $1', [RACE_OWNER])
    await database.query('DELETE FROM identity.users WHERE owner_user_id = $1', [RACE_OWNER])
    await database.query('DELETE FROM identity.gugu_devices WHERE device_id = $1', [RACE_DEVICE])
    // 删 auth 账号要求那个 human 身份还在(它自己连带清掉 identity 行与 agent_name_serials)。
    await database.query('DELETE FROM auth.users WHERE id = $1', [RACE_OWNER])
  }
  await database?.end()
})

async function inRollback(body: () => Promise<void>): Promise<void> {
  await database.query('BEGIN')
  try {
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

// auth.users 那一行会顺带建出 identity.users(human);agent_profiles.owner_id 的外键指的是 auth.users。
async function seedOwner(client: DatabaseClient, owner: string, device: string): Promise<void> {
  await client.query('INSERT INTO auth.users (id, created_at) VALUES ($1, now())', [owner])
  await client.query(
    `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform)
     VALUES ($1, $2, 'it-6396', 'it-6396', 'darwin')`,
    [device, owner],
  )
}

async function asOwner<T>(client: DatabaseClient, owner: string, body: () => Promise<T>): Promise<T> {
  await client.query(
    "SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)",
    [owner],
  )
  await client.query('SET LOCAL role authenticated')
  try {
    return await body()
  } finally {
    await client.query('RESET role')
  }
}

async function provision(
  client: DatabaseClient,
  owner: string,
  device: string,
  candidate: string,
  mode: 'serial' | 'explicit' = 'serial',
  agentId: string = randomUUID(),
): Promise<string> {
  return asOwner(client, owner, async () => {
    const result = await client.query<{ display_name: string }>(
      `SELECT display_name FROM identity.provision_taskpage_agent($1::uuid, $2, $3, 'claude-code', $4)`,
      [agentId, candidate, mode, device],
    )
    return result.rows[0].display_name
  })
}

async function highWater(owner: string, base: string): Promise<number | null> {
  const result = await database.query<{ high_water: number }>(
    'SELECT high_water FROM identity.agent_name_serials WHERE owner_user_id = $1 AND base = $2',
    [owner, base],
  )
  return result.rows[0]?.high_water ?? null
}

describe('#6396 agent default serials only go up', () => {
  it('numbers consecutive mints, and never hands a deleted number back out', async () => {
    await inRollback(async () => {
      await seedOwner(database, OWNER, DEVICE)
      expect(await provision(database, OWNER, DEVICE, 'Claude 1')).toBe('Claude 1')
      expect(await provision(database, OWNER, DEVICE, 'Claude 2')).toBe('Claude 2')
      const third = randomUUID()
      expect(await provision(database, OWNER, DEVICE, 'Claude 3', 'serial', third)).toBe('Claude 3')

      await asOwner(database, OWNER, () => database.query('SELECT identity.remove_owned_agent($1)', [third]))

      // 两个 agent 还在:旧规则(数量 + 1)会把 3 再发一次 —— 老客户端递上来的正是这个候选。
      expect(await provision(database, OWNER, DEVICE, 'Claude 3')).toBe('Claude 4')
      expect(await highWater(OWNER, 'Claude')).toBe(4)
    })
  })

  it('lifts a stale low candidate above the highest number already used (the Claude 28 → 18 case)', async () => {
    await inRollback(async () => {
      await seedOwner(database, OWNER, DEVICE)
      await database.query(
        `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id)
         VALUES ('agent-it-6396-28', 'agent', 'Claude 28', $1, $2)`,
        [OWNER, DEVICE],
      )
      expect(await highWater(OWNER, 'Claude')).toBe(28)
      expect(await provision(database, OWNER, DEVICE, 'Claude 18')).toBe('Claude 29')
    })
  })

  it('does not burn a number on an idempotent retry of the same agent id', async () => {
    await inRollback(async () => {
      await seedOwner(database, OWNER, DEVICE)
      const id = randomUUID()
      expect(await provision(database, OWNER, DEVICE, 'Claude 1', 'serial', id)).toBe('Claude 1')
      expect(await provision(database, OWNER, DEVICE, 'Claude 1', 'serial', id)).toBe('Claude 1')
      expect(await highWater(OWNER, 'Claude')).toBe(1)
      expect(await provision(database, OWNER, DEVICE, 'Claude 2')).toBe('Claude 2')
    })
  })

  it('counts a number reached by renaming as used', async () => {
    await inRollback(async () => {
      await seedOwner(database, OWNER, DEVICE)
      const id = randomUUID()
      await provision(database, OWNER, DEVICE, 'Claude 1', 'serial', id)
      await asOwner(database, OWNER, () =>
        database.query(`UPDATE identity.users SET display_name = 'Claude 40' WHERE id = $1`, [id]))
      await asOwner(database, OWNER, () =>
        database.query(`UPDATE identity.users SET display_name = '压页数' WHERE id = $1`, [id]))
      expect(await provision(database, OWNER, DEVICE, 'Claude 2')).toBe('Claude 41')
    })
  })

  it('keeps a name the device already gave out when the cloud half lands late (explicit mode)', async () => {
    await inRollback(async () => {
      await seedOwner(database, OWNER, DEVICE)
      expect(await provision(database, OWNER, DEVICE, 'Claude 30')).toBe('Claude 30')
      // 离线时本机先起了 Claude 29,云端那一发现在才补上:它的名字已经给过 agent 和用户,不改。
      expect(await provision(database, OWNER, DEVICE, 'Claude 29', 'explicit')).toBe('Claude 29')
      expect(await highWater(OWNER, 'Claude')).toBe(30)
      expect(await provision(database, OWNER, DEVICE, 'Claude 29')).toBe('Claude 31')
    })
  })

  it('when a kept name is already taken, takes the next unused number instead of gluing on " 2"', async () => {
    await inRollback(async () => {
      await seedOwner(database, OWNER, DEVICE)
      await provision(database, OWNER, DEVICE, 'Claude 29')
      await provision(database, OWNER, DEVICE, 'Claude 30')
      // 本机离线时也起了一个 Claude 29,补登记时发现另一台电脑已经用掉了这个号。
      expect(await provision(database, OWNER, DEVICE, 'Claude 29', 'explicit')).toBe('Claude 31')
    })
  })

  it('still suffixes a taken plain explicit name 2, 3, … and never re-issues a deleted suffix', async () => {
    await inRollback(async () => {
      await seedOwner(database, OWNER, DEVICE)
      expect(await provision(database, OWNER, DEVICE, '小弟', 'explicit')).toBe('小弟')
      const second = randomUUID()
      expect(await provision(database, OWNER, DEVICE, '小弟', 'explicit', second)).toBe('小弟 2')
      await asOwner(database, OWNER, () => database.query('SELECT identity.remove_owned_agent($1)', [second]))
      expect(await provision(database, OWNER, DEVICE, '小弟', 'explicit')).toBe('小弟 3')
    })
  })

  it('keeps one sequence per owner and per name prefix', async () => {
    await inRollback(async () => {
      await seedOwner(database, OWNER, DEVICE)
      await seedOwner(database, OTHER_OWNER, OTHER_DEVICE)
      await provision(database, OWNER, DEVICE, 'Claude 5')
      expect(await provision(database, OWNER, DEVICE, 'Codex 1')).toBe('Codex 1')
      expect(await provision(database, OTHER_OWNER, OTHER_DEVICE, 'Claude 1')).toBe('Claude 1')
      expect(await highWater(OWNER, 'Claude')).toBe(5)
      expect(await highWater(OWNER, 'Codex')).toBe(1)
    })
  })

  it('lets an owner read only their own high-water rows, and write none', async () => {
    await inRollback(async () => {
      await seedOwner(database, OWNER, DEVICE)
      await seedOwner(database, OTHER_OWNER, OTHER_DEVICE)
      await provision(database, OWNER, DEVICE, 'Claude 3')
      await provision(database, OTHER_OWNER, OTHER_DEVICE, 'Claude 7')
      const visible = await asOwner(database, OWNER, () =>
        database.query<{ owner_user_id: string; base: string; high_water: number }>(
          'SELECT owner_user_id, base, high_water FROM identity.agent_name_serials ORDER BY base'))
      expect(visible.rows).toEqual([{ owner_user_id: OWNER, base: 'Claude', high_water: 3 }])

      // 写被拒会让事务进入 aborted ⇒ 包一层 savepoint,回滚到它(连同 SET LOCAL role)再往下读。
      await database.query('SAVEPOINT write_attempt')
      await database.query(
        "SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)",
        [OWNER],
      )
      await database.query('SET LOCAL role authenticated')
      await expect(database.query(`UPDATE identity.agent_name_serials SET high_water = 0 WHERE owner_user_id = $1`, [OWNER]))
        .rejects.toThrow(/permission denied/)
      await database.query('ROLLBACK TO SAVEPOINT write_attempt')
      expect(await highWater(OWNER, 'Claude')).toBe(3)
    })
  })

  it('serialises concurrent mints of the same prefix (serial vs serial, explicit vs serial) into different numbers', async () => {
    const first = new Client({ connectionString: DATABASE_URL })
    const second = new Client({ connectionString: DATABASE_URL })
    await first.connect()
    await second.connect()
    try {
      await seedOwner(database, RACE_OWNER, RACE_DEVICE)
      await first.query('BEGIN')
      await second.query('BEGIN')
      // 两边拿着同一个候选(两台电脑、两条会话同一刻起号)。第一发占住号不提交,第二发必须等它。
      const firstName = await provision(first, RACE_OWNER, RACE_DEVICE, 'Claude 1')
      let secondSettled = false
      const secondName = provision(second, RACE_OWNER, RACE_DEVICE, 'Claude 1').finally(() => { secondSettled = true })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(secondSettled).toBe(false)
      await first.query('COMMIT')
      const secondResolved = await secondName
      await second.query('COMMIT')
      expect([firstName, secondResolved]).toEqual(['Claude 1', 'Claude 2'])

      // 一发保名、一发起号撞同一个号:保名那发先拿到锁,起号那发必须等它提交再往上跳。
      await first.query('BEGIN')
      await second.query('BEGIN')
      const kept = await provision(first, RACE_OWNER, RACE_DEVICE, 'Claude 5', 'explicit')
      let serialSettled = false
      const serialName = provision(second, RACE_OWNER, RACE_DEVICE, 'Claude 5').finally(() => { serialSettled = true })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(serialSettled).toBe(false)
      await first.query('COMMIT')
      const lifted = await serialName
      await second.query('COMMIT')
      expect([kept, lifted]).toEqual(['Claude 5', 'Claude 6'])
    } finally {
      await first.query('ROLLBACK').catch(() => undefined)
      await second.query('ROLLBACK').catch(() => undefined)
      await first.end()
      await second.end()
    }
  })
})
