import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * nmhjklnm/gugu#6264:无发送者的系统消息(「agent 较多,已把它们都转为被动模式」)给当时 active 的 agent
 * 入了 agent.deliver,但设备执行前的租约复核(identity.recheck_device_command_execution)把「发送者为空」
 * 判成 'device command context does not match message' —— 推送一律终态失败,读者从没被叫醒,
 * 消息要等那个 agent 下一次回合结束 / 会话转 live / 宿主重启才被拉到(实机:迟到数小时、每次重启一批)。
 *
 * #6860 起没点名的无发送者系统行不再唤醒 agent,仍会推送的无发送者系统行只剩点名的那种(#6562 的表情通知);
 * 复核改查唤醒名单 + content_type = 'system',不再读已删的冻结档位表。
 *
 * 判据:同一台设备、同一种领取方式,
 *   · 点名 agent 的服务端系统行,推送复核通过(修前抛错);
 *   · 阳控:真人发的消息复核通过;
 *   · 阴控:发送者被注销抹空的消息(#2051 形状)复核仍然拒。
 *
 * 跑法:loopback `GUGU_INTEGRATION_DATABASE_URL`(跑过全部迁移的库);每条用例 BEGIN…ROLLBACK。
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

const OWNER = '62640000-0000-4000-8000-000000000001'
const AGENT = 'agent-it-6264'
const DEVICE = 'dev-it-6264'
const GROUP = '62640000-0000-4000-8000-000000000003'

let database: DatabaseClient

function requireLoopbackDatabase(): void {
  let parsed: URL
  try {
    parsed = new URL(DATABASE_URL)
  } catch {
    throw new Error('GUGU_INTEGRATION_DATABASE_URL is required')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`systemMessageNudgeRecheck6264.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`systemMessageNudgeRecheck6264.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
}

beforeAll(async () => {
  requireLoopbackDatabase()
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})

afterAll(async () => {
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

async function seed(): Promise<void> {
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','owner')`, [OWNER])
  await database.query(
    `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform)
     VALUES ($1, $2, 'it-6264', 'it-6264', 'darwin')`,
    [DEVICE, OWNER],
  )
  await database.query(
    `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id)
     VALUES ($1,'agent','claude',$2,$3)`,
    [AGENT, OWNER, DEVICE],
  )
  await database.query(
    `INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','shared',$2)`,
    [GROUP, OWNER],
  )
  await database.query(
    `INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode)
     VALUES ($1,$2,'owner','active'),($1,$3,'member','active')`,
    [GROUP, OWNER, AGENT],
  )
}

async function send(id: string, sender: string | null, contentType: 'text' | 'system', to: string[] | null = null): Promise<void> {
  await database.query(
    `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, GROUP, sender, `body of ${id}`, contentType, to],
  )
}

/** 设备领取这条消息叫醒 AGENT 的那条 agent.deliver(与 claimDeviceCommand 同形:pending → running + claim_token)。 */
async function claimNudgeFor(messageId: string): Promise<{ id: string; claimToken: string }> {
  const claimToken = randomUUID()
  const { rows } = await database.query<{ id: string }>(
    `UPDATE identity.gugu_device_commands
        SET status = 'running', claim_token = $2
      WHERE type = 'agent.deliver' AND status = 'pending'
        AND payload->>'agent_user_id' = $3 AND payload->>'message_id' = $1
      RETURNING id`,
    [messageId, claimToken, AGENT],
  )
  expect(rows, `message ${messageId} should have enqueued exactly one nudge for the agent`).toHaveLength(1)
  return { id: rows[0]!.id, claimToken }
}

/** 设备侧执行前的复核,以属主身份调用(与 recheckDeviceCommandExecution 同一个 RPC)。 */
async function recheckAsOwner(command: { id: string; claimToken: string }): Promise<boolean> {
  await database.query('SAVEPOINT recheck')
  try {
    await database.query(
      "SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)",
      [OWNER],
    )
    await database.query('SET LOCAL role authenticated')
    const { rows } = await database.query<{ ok: boolean }>(
      'SELECT identity.recheck_device_command_execution($1::uuid, $2::uuid) AS ok',
      [command.id, command.claimToken],
    )
    await database.query('RESET role')
    await database.query('RELEASE SAVEPOINT recheck')
    return rows[0]!.ok
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT recheck')
    await database.query('RESET role')
    throw error
  }
}

describe('#6264 system-message nudge survives the device command recheck', () => {
  it('a server system notice naming the agent passes the recheck', async () => {
    await inRollback(async () => {
      await seed()
      await send('notice-it-6264', null, 'system', [AGENT])
      expect(await recheckAsOwner(await claimNudgeFor('notice-it-6264'))).toBe(true)
    })
  })

  it('control: a human message passes the recheck', async () => {
    await inRollback(async () => {
      await seed()
      await send('human-it-6264', OWNER, 'text')
      expect(await recheckAsOwner(await claimNudgeFor('human-it-6264'))).toBe(true)
    })
  })

  it('a message whose sender was erased is still refused', async () => {
    await inRollback(async () => {
      await seed()
      await send('erased-it-6264', OWNER, 'text')
      const command = await claimNudgeFor('erased-it-6264')
      // #2051 的注销形状:消息与在途命令的发送者都被抹空,而它从来不是系统事件。
      await database.query(`UPDATE chat.messages SET sender_user_id = NULL WHERE id = 'erased-it-6264'`)
      await database.query(
        `UPDATE identity.gugu_device_commands SET payload = payload || '{"sender_user_id": null}'::jsonb WHERE id = $1`,
        [command.id],
      )
      await expect(recheckAsOwner(command)).rejects.toThrow('device command context does not match message')
    })
  })
})
