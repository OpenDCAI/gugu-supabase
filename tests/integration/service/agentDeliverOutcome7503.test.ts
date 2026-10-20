import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as { Client: new (config: { connectionString: string }) => DatabaseClient }
let db: DatabaseClient
let owner: string
let command: string
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('agentDeliverOutcome7503 requires loopback PostgreSQL')
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); command = randomUUID()
  // 没有真实设备、账号或投递：临时表只挂生产触发器函数，真实realtime.send写入也随本事务回滚。
  await db.query(`CREATE TEMP TABLE outcome7503 (LIKE identity.gugu_device_commands INCLUDING DEFAULTS) ON COMMIT DROP;
    CREATE TRIGGER outcome7503 AFTER UPDATE OF status ON outcome7503 FOR EACH ROW EXECUTE FUNCTION identity.broadcast_agent_deliver_outcome_7503()`)
  await db.query(`INSERT INTO outcome7503(id,user_id,device_id,type,status,payload) VALUES($1,$2,'fixture','agent.deliver','pending',$3::jsonb)`, [command, owner, JSON.stringify({ agent_user_id: 'agent', chat_id: 'chat', thread_root_id: 'thread', content: 'private message' })])
})
afterEach(async () => { await db?.query('ROLLBACK') })

async function events() {
  return (await db.query<{ event: string; topic: string; private: boolean; payload: Record<string, unknown> }>(
    "SELECT event,topic,private,payload FROM realtime.messages WHERE event='agent_deliver_changed' AND payload->>'id'=$1 ORDER BY inserted_at", [command],
  )).rows
}

describe('跨设备的投递结果通知 #7503', () => {
  it('只发owner私有频道的最小失效键，不含错误和消息原文', async () => {
    expect(await events()).toEqual([])
    await db.query("UPDATE outcome7503 SET status='error',error='private provider trace' WHERE id=$1", [command])
    expect(await events()).toEqual([{ event: 'agent_deliver_changed', topic: `gugu:user:${owner}:events`, private: true, payload: { id: command, status: 'error', agent_user_id: 'agent', chat_id: 'chat', thread_root_id: 'thread' } }])
  })
  it('重试、开始和成功也发变更；相同状态和其他命令不发', async () => {
    for (const status of ['running', 'error', 'pending', 'running', 'done']) await db.query('UPDATE outcome7503 SET status=$1 WHERE id=$2', [status, command])
    expect(await events()).toHaveLength(5)
    await db.query("UPDATE outcome7503 SET status='done',error='different text' WHERE id=$1", [command])
    await db.query("UPDATE outcome7503 SET type='agent.create',status='error' WHERE id=$1", [command])
    expect(await events()).toHaveLength(5)
  })
  it('触发器函数不作为真人或匿名可调用的RPC开放', async () => {
    const { rows } = await db.query<{ authenticated: boolean; anon: boolean; service: boolean }>(`SELECT
      has_function_privilege('authenticated','identity.broadcast_agent_deliver_outcome_7503()','EXECUTE') AS authenticated,
      has_function_privilege('anon','identity.broadcast_agent_deliver_outcome_7503()','EXECUTE') AS anon,
      has_function_privilege('service_role','identity.broadcast_agent_deliver_outcome_7503()','EXECUTE') AS service`)
    expect(rows).toEqual([{ authenticated: false, anon: false, service: true }])
  })
})
