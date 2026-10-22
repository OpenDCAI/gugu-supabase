// @@@6860 没有发信人、也没点名的系统行(入群灰字、agent 较多……)不唤醒 agent —— 对着**真库**跑的判官。
//
// 规则活在唯一的唤醒谓词 chat.message_wakes_agent 里(没点名的那一支要有发信人):推送不排 agent.deliver、
// #6400 的唤醒名单不记,拉取只认唤醒名单,于是也拉不到。每条否定断言都配正对照:
//   · 同一群里一条没点名的人话照常唤醒 active agent;
//   · 点名的无发信人系统行(#6562「X 对你的消息点了表情」那种)照常唤醒被点名的 agent;
//   · 有发信人的系统行(开话题、宿主披露行那种)与改前一样:没点名就不唤醒别的 agent,点名就唤醒被点名的。
//
// 与 groupMemberJoinNotice6386 同形:loopback PostgreSQL、`GUGU_INTEGRATION_DATABASE_URL`,每条用例 BEGIN…ROLLBACK。
// 跑法:`GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:34890/postgres \
//        pnpm exec vitest run undirectedSystemNoticeNoWake6860`
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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
  process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? ''
).trim()

let database: DatabaseClient

function requireLoopbackDatabase(): void {
  let parsed: URL
  try {
    parsed = new URL(DATABASE_URL)
  } catch {
    throw new Error('GUGU_INTEGRATION_DATABASE_URL is required')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`undirectedSystemNoticeNoWake6860.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`undirectedSystemNoticeNoWake6860.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
}

function uid(tag: string, n: number): string {
  const head = tag.padEnd(8, '0').slice(0, 8).replace(/[^0-9a-f]/g, '0')
  return `${head}-6860-4000-8000-${String(n).padStart(12, '0')}`
}

beforeAll(async () => {
  requireLoopbackDatabase()
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})
afterAll(async () => { await database?.end() })

async function inRollback(body: () => Promise<void>): Promise<void> {
  await database.query('BEGIN')
  try {
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

interface Room { owner: string; alice: string; group: string; agents: string[] }

/**
 * 一个一小时前建好的群:群主、三个 active 的 agent(挂在群主的设备上,推送够得着)。Alice 待命,还没入群。
 * 数量线用默认的 5,三个 agent 不过线;用例自己把线调低来触发「agent 较多」。
 */
async function seedRoom(tag: string): Promise<Room> {
  const room: Room = {
    owner: uid(tag, 1), alice: uid(tag, 2), group: uid(tag, 11),
    agents: [uid(tag, 4), uid(tag, 5), uid(tag, 6)],
  }
  const device = `dev-6860-${tag}`
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','群主'),($2,'human','Alice')`, [room.owner, room.alice])
  await database.query(
    `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ($1, $2, 'it-6860', 'it-6860', 'darwin')`,
    [device, room.owner],
  )
  for (const [index, agent] of room.agents.entries()) {
    await database.query(
      `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id) VALUES ($1,'agent',$2,$3,$4)`,
      [agent, `Claude ${index + 3}`, room.owner, device],
    )
  }
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','群',$2)`, [room.group, room.owner])
  await database.query(
    `INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode)
     SELECT $1, u, CASE WHEN u = $2 THEN 'owner' ELSE 'member' END, 'active' FROM unnest($3::text[]) AS u`,
    [room.group, room.owner, [room.owner, ...room.agents]],
  )
  // 建群那一刻带进来的是初始成员;拨回一小时,之后的入群才是「后来进来」(与 #6386 的夹具同形)。
  await database.query(`UPDATE chat.chats SET created_at = now() - interval '1 hour' WHERE id = $1`, [room.group])
  return room
}

async function wokenBy(messageId: string): Promise<string[]> {
  const { rows } = await database.query<{ agent_user_id: string }>(
    `SELECT agent_user_id FROM chat.message_agent_wakes WHERE message_id = $1 ORDER BY agent_user_id`, [messageId],
  )
  return rows.map((row) => row.agent_user_id)
}

async function nudgedBy(messageId: string): Promise<string[]> {
  const { rows } = await database.query<{ agent: string }>(
    `SELECT payload->>'agent_user_id' AS agent FROM identity.gugu_device_commands
     WHERE type = 'agent.deliver' AND payload->>'message_id' = $1 ORDER BY 1`, [messageId],
  )
  return rows.map((row) => row.agent)
}

async function systemRow(chatId: string, markerPrefix: string): Promise<string> {
  const { rows } = await database.query<{ id: string }>(
    `SELECT id FROM chat.messages WHERE chat_id = $1 AND content_type = 'system' AND client_message_id LIKE $2 || '%'`,
    [chatId, markerPrefix],
  )
  expect(rows, `exactly one ${markerPrefix} row`).toHaveLength(1)
  return rows[0]!.id
}

async function insertMessage(row: {
  id: string; chatId: string; sender: string | null; content: string; type: 'text' | 'system'
  to?: string[]; whisper?: boolean; marker?: string
}): Promise<void> {
  await database.query(
    `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, is_whisper, client_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [row.id, row.chatId, row.sender, row.content, row.type, row.to ?? null, row.whisper ?? false, row.marker ?? null],
  )
}

describe('#6860 没有发信人、也没点名的系统行不唤醒 agent(对着真库跑)', () => {
  it('「agent 较多」那一行:不进唤醒名单、不排 agent.deliver;阳控:同一群里没点名的人话照常唤醒', () => inRollback(async () => {
    const room = await seedRoom('f1')
    const sorted = [...room.agents].sort()

    // 阳控:群主一条没点名的话,三个 active agent 都被唤醒、各排一条推送。
    const talk = uid('f1', 21)
    await insertMessage({ id: talk, chatId: room.group, sender: room.owner, content: '大家看一下', type: 'text' })
    expect(await wokenBy(talk)).toEqual(sorted)
    expect(await nudgedBy(talk)).toEqual(sorted)

    // 群主把数量线调到 2 ⇒ 三个过线,服务端落「agent 较多」。
    await database.query('UPDATE chat.chats SET agent_flood_threshold = 2 WHERE id = $1', [room.group])
    const flood = await systemRow(room.group, 'agent-flood:')
    expect(await wokenBy(flood)).toEqual([])
    expect(await nudgedBy(flood)).toEqual([])
  }))

  it('入群灰字仍然不唤醒(#6386 由同一条规则覆盖)', () => inRollback(async () => {
    const room = await seedRoom('f2')
    await database.query('SELECT chat.insert_group_member($1,$2)', [room.group, room.alice])
    const joined = await systemRow(room.group, 'member-joined:')
    expect(await wokenBy(joined)).toEqual([])
    expect(await nudgedBy(joined)).toEqual([])
  }))

  it('点名的无发信人系统行(#6562 那种)只唤醒被点名的那个 agent', () => inRollback(async () => {
    const room = await seedRoom('f3')
    const named = room.agents[0]!
    const notice = uid('f3', 31)
    await insertMessage({
      id: notice, chatId: room.group, sender: null, content: 'Alice 对你的消息点了 👍', type: 'system',
      to: [named], whisper: true, marker: `reaction:${notice}`,
    })
    expect(await wokenBy(notice)).toEqual([named])
    expect(await nudgedBy(notice)).toEqual([named])
  }))

  it('有发信人的系统行与改前一样:agent 发的没点名行不唤醒别的 agent;阳控:它点名的那个照常被唤醒', () => inRollback(async () => {
    const room = await seedRoom('f4')
    const [opener, other] = room.agents as [string, string, string]
    const row = uid('f4', 41)
    await insertMessage({ id: row, chatId: room.group, sender: opener, content: 'Claude 3 开了话题:上线检查', type: 'system', marker: `topic-opened:${uid('f4', 42)}` })
    expect(await wokenBy(row)).toEqual([])
    expect(await nudgedBy(row)).toEqual([])
    const handoff = uid('f4', 43)
    await insertMessage({ id: handoff, chatId: room.group, sender: opener, content: '交接给你', type: 'system', to: [other] })
    expect(await wokenBy(handoff)).toEqual([other])
    expect(await nudgedBy(handoff)).toEqual([other])
  }))
})
