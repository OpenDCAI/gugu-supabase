// @@@6386 「X 加入了群聊」这行灰字 —— 对着**真库**跑的判官。
//
// 规则整个活在 chat_members 的语句级触发器里,界面只是把它画出来,所以只有真库判得了:
//   · 群里有人进来 → 一行系统消息,入群者 id 编在 client_message_id(客户端据此画可点的 @);
//   · 一条语句进来多个人 → 合成一行;
//   · 建群同一事务带进来的初始成员、私聊、话题、ON CONFLICT 跳过的 → 都不发;
//   · 这行灰字不唤醒 agent:没有发信人、也没点名(#6860 的唤醒谓词);点名 agent 的系统消息是正对照。
//
// 与 agentFloodThreshold5856 同形:loopback PostgreSQL、`GUGU_INTEGRATION_DATABASE_URL`。
// 跑法:`GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:34890/postgres \
//        pnpm exec vitest run groupMemberJoinNotice6386`
//
// 每条用例 BEGIN…ROLLBACK。夹具先按产品的样子建群带群主(同事务,不发),再把建群时间拨回一小时 ——
// 否则用例里的入群也与建群同事务,触发器按「初始成员」不发,那恰好是另一条用例要判的东西。
// 每条否定断言都配正对照。
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
    throw new Error(`groupMemberJoinNotice6386.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`groupMemberJoinNotice6386.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
}

function uid(tag: string, n: number): string {
  const head = tag.padEnd(8, '0').slice(0, 8).replace(/[^0-9a-f]/g, '0')
  return `${head}-cccc-4000-8000-${String(n).padStart(12, '0')}`
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

interface Room { owner: string; group: string; alice: string; bob: string; agent: string }

async function user(id: string, type: 'human' | 'agent', name: string, device: string | null = null): Promise<void> {
  await database.query(
    `INSERT INTO identity.users (id, type, display_name, device_id) VALUES ($1,$2,$3,$4)`,
    [id, type, name, device],
  )
}

/** 一个一小时前建好的群,群主在里面;Alice、Bob、一个 agent 待命,还没入群。 */
async function seedRoom(tag: string): Promise<Room> {
  const room: Room = {
    owner: uid(tag, 1), alice: uid(tag, 2), bob: uid(tag, 3), agent: uid(tag, 4), group: uid(tag, 11),
  }
  // agent 必须挂在一台设备上(identity.users 的 users_agent_device_required),设备归群主。
  const device = `dev-join-${tag}`
  await database.query(
    `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform)
     VALUES ($1, $2, 'join', 'join', 'darwin')`,
    [device, room.owner],
  )
  await user(room.owner, 'human', '群主')
  await user(room.alice, 'human', 'Alice')
  await user(room.bob, 'human', 'Bob')
  await user(room.agent, 'agent', 'Claude 5', device)
  // 与产品里建群同形:建群和群主入群在同一个事务里(群主是初始成员,不发)。建好之后再把建群时间
  // 拨回一小时,模拟「群早就建好了」—— 之后每条用例里的入群才是真的「后来进来」。
  await database.query(
    `INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','群',$2)`,
    [room.group, room.owner],
  )
  await database.query(
    `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'owner')`,
    [room.group, room.owner],
  )
  await database.query(`UPDATE chat.chats SET created_at = now() - interval '1 hour' WHERE id = $1`, [room.group])
  return room
}

interface Notice { id: string; content: string; client_message_id: string; sender_user_id: string | null }

async function joinNotices(chatId: string): Promise<Notice[]> {
  const { rows } = await database.query<Notice>(
    `SELECT id, content, client_message_id, sender_user_id FROM chat.messages
     WHERE chat_id = $1 AND content_type = 'system' AND client_message_id LIKE 'member-joined:%'
     ORDER BY seq`,
    [chatId],
  )
  return rows
}

async function join(chatId: string, ...userIds: string[]): Promise<void> {
  const values = userIds.map((_, index) => `($1, $${index + 2}, 'member')`).join(', ')
  await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ${values}`, [chatId, ...userIds])
}

describe('#6386 入群灰字(对着真库跑)', () => {
  it('群里进来一个人 → 一行「X 加入了群聊」,入群者 id 编在 client_message_id', () => inRollback(async () => {
    const room = await seedRoom('a1')
    expect(await joinNotices(room.group)).toEqual([])

    await join(room.group, room.alice)

    const [notice, ...rest] = await joinNotices(room.group)
    expect(rest).toEqual([])
    expect(notice!.content).toBe('Alice 加入了群聊')
    expect(notice!.sender_user_id).toBeNull()
    expect(notice!.client_message_id).toBe(`member-joined:${notice!.id}:${room.alice}`)
  }))

  it('一条语句进来两个人 → 合成一行;分两次进 → 两行', () => inRollback(async () => {
    const room = await seedRoom('a2')
    await join(room.group, room.alice, room.bob)
    const merged = await joinNotices(room.group)
    expect(merged).toHaveLength(1)
    const ids = merged[0]!.client_message_id.split(':')[2]!.split(',')
    expect(ids.sort()).toEqual([room.alice, room.bob].sort())

    // 正对照:分开进来就是分开的两行。
    await database.query('DELETE FROM chat.chat_members WHERE chat_id = $1 AND user_id = ANY($2::text[])', [room.group, [room.alice, room.bob]])
    await join(room.group, room.alice)
    await join(room.group, room.bob)
    expect(await joinNotices(room.group)).toHaveLength(3)
  }))

  it('与建群同一事务带进来的初始成员不发;建好之后再进来的照发', () => inRollback(async () => {
    const room = await seedRoom('a3')
    const fresh = uid('a3', 12)
    await database.query(
      `INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','新群',$2)`,
      [fresh, room.owner],
    )
    await join(fresh, room.alice, room.bob)
    expect(await joinNotices(fresh)).toEqual([])

    // 正对照:同样的插入,放在一小时前建的群里就发。
    await join(room.group, room.alice, room.bob)
    expect(await joinNotices(room.group)).toHaveLength(1)
  }))

  it('私聊与话题不发', () => inRollback(async () => {
    const room = await seedRoom('a4')
    const dm = uid('a4', 13)
    const topic = uid('a4', 14)
    const source = uid('a4', 21)
    await database.query(
      `INSERT INTO chat.chats (id, kind, name, creator_user_id, created_at) VALUES ($1,'dm',NULL,$2, now() - interval '1 hour')`,
      [dm, room.owner],
    )
    await join(dm, room.alice)
    expect(await joinNotices(dm)).toEqual([])

    await join(room.group, room.alice)
    await database.query(
      `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type) VALUES ($1,$2,$3,'源消息','text')`,
      [source, room.group, room.owner],
    )
    await database.query(
      `INSERT INTO chat.chats (id, kind, name, creator_user_id, source_chat_id, source_message_id, created_at)
       VALUES ($1,'topic','话题',$2,$3,$4, now() - interval '1 hour')`,
      [topic, room.owner, room.group, source],
    )
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'owner')`, [topic, room.owner])
    await join(topic, room.alice)
    expect(await joinNotices(topic)).toEqual([])
    // 正对照:Alice 进群那一次是发了的。
    expect(await joinNotices(room.group)).toHaveLength(1)
  }))

  it('ON CONFLICT 跳过的(本来就在群里)不再发一行', () => inRollback(async () => {
    const room = await seedRoom('a5')
    await join(room.group, room.alice)
    await database.query(
      `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member'),($1,$3,'member')
       ON CONFLICT (chat_id, user_id) DO NOTHING`,
      [room.group, room.alice, room.bob],
    )
    const notices = await joinNotices(room.group)
    expect(notices.map((notice) => notice.content)).toEqual(['Alice 加入了群聊', 'Bob 加入了群聊'])
  }))

  it('入群灰字不唤醒 agent;点名这个 agent 的系统消息照常唤醒它', () => inRollback(async () => {
    const room = await seedRoom('a6')
    await database.query(
      `INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode) VALUES ($1,$2,'member','active')`,
      [room.group, room.agent],
    )
    await join(room.group, room.alice)
    const notices = await joinNotices(room.group)
    // agent 自己入群那一行 + Alice 入群那一行
    expect(notices).toHaveLength(2)
    const { rows: woken } = await database.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM chat.message_agent_wakes WHERE message_id = ANY($1::text[])`,
      [notices.map((notice) => notice.id)],
    )
    expect(woken[0]!.n).toBe(0)

    // 正对照:一条点名这个 agent 的系统消息(同样无发送者),照常唤醒它。
    // (#6860 起没点名的无发送者系统行一律不唤醒,入群灰字是其中一种,见 undirectedSystemNoticeNoWake6860。)
    const other = uid('a6', 31)
    await database.query(
      `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, client_message_id)
       VALUES ($1,$2,NULL,'别的系统事件','system',ARRAY[$3],'other:' || $1)`,
      [other, room.group, room.agent],
    )
    const { rows: control } = await database.query<{ agent_user_id: string }>(
      `SELECT agent_user_id FROM chat.message_agent_wakes WHERE message_id = $1`,
      [other],
    )
    expect(control).toEqual([{ agent_user_id: room.agent }])
  }))
})
