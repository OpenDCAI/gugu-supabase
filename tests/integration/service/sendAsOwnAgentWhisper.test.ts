// A page an agent works sends in that agent's name (gugu, owner 10-14): the App's send calls send_message_idempotent with
// the person's token and p_sender_user_id = the person's agent, a whisper. The person does not see that whisper, and the
// function is SECURITY INVOKER, so its replay lookup, App rate count and read-back go through three helpers that read as
// that agent (20261014032613). Against a real database:
//   · the person's own send is as before, and the helpers answer nothing for it;
//   · as their own agent: sent, a replay converges, a changed replay is a conflict, and its whispers are counted;
//   · a sender that is not their own agent is refused, as before;
//   · called directly, the helpers read nothing of another person's agent, nothing of their own agent in another chat,
//     and nothing of a whisper sent TO their agent; anon cannot call them;
//   · they read only what this App sent in the agent's name: not what the agent wrote itself (a whisper, or in a group
//     the person is not in), not what another App sent for it (review 84106e6d03).
//
// Same shape as messageViaAppF16: loopback PostgreSQL, `GUGU_INTEGRATION_DATABASE_URL`, each case BEGIN…ROLLBACK.
// Run: `GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:34890/postgres \
//       pnpm exec vitest run sendAsOwnAgentWhisper`
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
const DATABASE_URL = (process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '').trim()
let database: DatabaseClient

beforeAll(async () => {
  const parsed = new URL(DATABASE_URL)
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`sendAsOwnAgentWhisper.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
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

function uid(tag: string, n: number): string {
  const head = tag.padEnd(8, '0').slice(0, 8).replace(/[^0-9a-f]/g, '0')
  return `${head}-a9e0-4000-8000-${String(n).padStart(12, '0')}`
}
let counter = 0
function messageId(): string {
  counter += 1
  return `7e5c0000-a9e0-4000-8000-${String(counter).padStart(12, '0')}`
}

interface Room { owner: string; alice: string; agent: string; other: string; otherAgent: string; group: string; second: string }

/** A group G: the owner, Alice, the owner's agent, another person and their agent. A second chat G2: the owner and their agent. */
async function seedRoom(tag: string): Promise<Room> {
  const room: Room = { owner: uid(tag, 1), alice: uid(tag, 2), agent: uid(tag, 3), other: uid(tag, 4), otherAgent: uid(tag, 5), group: uid(tag, 11), second: uid(tag, 12) }
  for (const [id, name] of [[room.owner, '主人'], [room.alice, 'Alice'], [room.other, '另一个人']] as const) {
    await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)`, [id, name])
  }
  for (const [agent, person, device] of [[room.agent, room.owner, `dev-asagent-${tag}-1`], [room.otherAgent, room.other, `dev-asagent-${tag}-2`]] as const) {
    await database.query(`INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ($1,$2,'asagent','asagent','darwin')`, [device, person])
    await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id) VALUES ($1,'agent','Agent',$2,$3)`, [agent, person, device])
  }
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','G',$3),($2,'group','G2',$3)`, [room.group, room.second, room.owner])
  await database.query(`UPDATE chat.chats SET created_at = now() - interval '1 hour' WHERE id IN ($1,$2)`, [room.group, room.second])
  for (const user of [room.owner, room.alice, room.agent, room.other, room.otherAgent]) {
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,$3)`, [room.group, user, user === room.owner ? 'owner' : 'member'])
  }
  for (const user of [room.owner, room.agent]) {
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,$3)`, [room.second, user, user === room.owner ? 'owner' : 'member'])
  }
  return room
}

/** As `userId` (authenticated, their claims), inside the running transaction; a failure is returned, not thrown. */
async function as<Row>(userId: string, sql: string, values: unknown[], role = 'authenticated'): Promise<{ rows?: Row[]; error?: { code: string; message: string } }> {
  await database.query('SAVEPOINT as_user')
  try {
    await database.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('role', $2, true)`, [JSON.stringify({ sub: userId, role }), role])
    const { rows } = await database.query<Row>(sql, values)
    await database.query('RELEASE SAVEPOINT as_user')
    await database.query(`SELECT set_config('role', 'postgres', true)`)
    return { rows }
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT as_user')
    await database.query(`SELECT set_config('role', 'postgres', true)`)
    const failure = error as { code?: string; message?: string }
    return { error: { code: String(failure.code), message: String(failure.message) } }
  }
}

/** The App's send, as gugu calls it: `caller`'s token, `sender` in the row, a whisper to `to`, through App `app`. */
function send(room: Room, caller: string, sender: string, to: string, id: string, app = 'calendar', content = 'a to-do for Friday') {
  return as<{ id: string; sender_user_id: string; is_whisper: boolean; via_app: string | null }>(
    caller,
    'SELECT id, sender_user_id, is_whisper, via_app FROM chat.send_message_idempotent($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [id, room.group, sender, [to], content, 'text', null, null, false, true, app],
  )
}

/** What each helper answers to `caller`, called directly (not through the send), for App `app`. */
async function helpers(caller: string, id: string, chat: string, sender: string, app = 'calendar') {
  const sent = await as<{ id: string }>(caller, 'SELECT id FROM chat.own_agent_sent($1,$2,$3,$4)', [id, chat, sender, app])
  const view = await as<{ id: string }>(caller, 'SELECT id FROM chat.own_agent_sent_view($1,$2,$3,$4)', [id, chat, sender, app])
  const count = await as<{ n: number | null }>(caller, 'SELECT chat.own_agent_app_sends($1,$2,$3) AS n', [chat, sender, app])
  // The count's error first: a NULL count is an answer, and `??` would read past it.
  return { sent: sent.rows?.length ?? sent.error, view: view.rows?.length ?? view.error, count: count.error ?? count.rows?.[0]?.n }
}

describe('an App\'s send in the person\'s own agent\'s name (owner 10-14)', () => {
  it('the person\'s own send is as before; the helpers answer nothing for it (the count is NULL, not 0)', async () => {
    await inRollback(async () => {
      const room = await seedRoom('as1')
      const id = messageId()
      const sent = await send(room, room.owner, room.owner, room.alice, id)
      expect(sent.error).toBeUndefined()
      expect(sent.rows?.[0]).toEqual({ id, sender_user_id: room.owner, is_whisper: true, via_app: 'calendar' })
      expect(await helpers(room.owner, id, room.group, room.owner)).toEqual({ sent: 0, view: 0, count: null })
    })
  })

  it('as their own agent: sent and read back, a replay converges, a changed replay is a conflict', async () => {
    await inRollback(async () => {
      const room = await seedRoom('as2')
      const id = messageId()
      const sent = await send(room, room.owner, room.agent, room.alice, id)
      expect(sent.error).toBeUndefined()
      expect(sent.rows?.[0]).toEqual({ id, sender_user_id: room.agent, is_whisper: true, via_app: 'calendar' })
      expect((await send(room, room.owner, room.agent, room.alice, id)).rows?.[0]?.id).toBe(id)
      const { rows } = await database.query<{ n: string }>('SELECT count(*) AS n FROM chat.messages WHERE id = $1', [id])
      expect(Number(rows[0]!.n)).toBe(1)
      const changed = await send(room, room.owner, room.agent, room.alice, id, 'calendar', 'something else')
      expect(changed.error?.code).toBe('23505')
      expect(changed.error?.message).toMatch(/^idempotency conflict for message/)
    })
  })

  it('their agent\'s whispers are counted: the 30th goes in, the 31st is PT429; the person\'s own count is apart', async () => {
    await inRollback(async () => {
      const room = await seedRoom('as3')
      for (let n = 1; n <= 30; n += 1) {
        expect((await send(room, room.owner, room.agent, room.alice, messageId(), 'calendar', `n${n}`)).error, `message ${n}`).toBeUndefined()
      }
      expect(await helpers(room.owner, messageId(), room.group, room.agent)).toMatchObject({ count: 30 })
      const refused = await send(room, room.owner, room.agent, room.alice, messageId(), 'calendar', 'n31')
      expect(refused.error?.code).toBe('PT429')
      expect((await send(room, room.owner, room.owner, room.alice, messageId())).error).toBeUndefined()
    })
  })

  it('a sender that is not their own agent is refused, as before', async () => {
    await inRollback(async () => {
      const room = await seedRoom('as4')
      expect((await send(room, room.owner, room.otherAgent, room.alice, messageId())).error?.code).toBe('42501')
    })
  })

  it('called directly: nothing of another person\'s agent, nothing of their own agent in another chat', async () => {
    await inRollback(async () => {
      const room = await seedRoom('as5')
      const others = messageId()
      expect((await send(room, room.other, room.otherAgent, room.alice, others)).error).toBeUndefined()
      expect(await helpers(room.owner, others, room.group, room.otherAgent)).toEqual({ sent: 0, view: 0, count: null })
      const mine = messageId()
      expect((await send(room, room.owner, room.agent, room.alice, mine)).error).toBeUndefined()
      expect(await helpers(room.owner, mine, room.group, room.agent)).toMatchObject({ sent: 1, view: 1 })
      expect(await helpers(room.owner, mine, room.second, room.agent)).toMatchObject({ sent: 0, view: 0 })
    })
  })

  it('a whisper sent TO their agent stays unreadable to them, through the helpers too', async () => {
    await inRollback(async () => {
      const room = await seedRoom('as6')
      const toAgent = messageId()
      expect((await send(room, room.alice, room.alice, room.agent, toAgent)).error).toBeUndefined()
      expect(await helpers(room.owner, toAgent, room.group, room.agent)).toMatchObject({ sent: 0, view: 0 })
      expect(await helpers(room.owner, toAgent, room.group, room.alice)).toEqual({ sent: 0, view: 0, count: null })
      const seen = await as<{ n: string }>(room.owner, 'SELECT count(*) AS n FROM chat.messages WHERE id = $1', [toAgent])
      expect(Number(seen.rows?.[0]?.n)).toBe(0)
    })
  })

  // Review 84106e6d03: by id they read any row of the agent's — its own whispers, in groups the person is not in. Now
  // only what this App sent in its name. Their control: the same reads answer this App's own send (as5), and the other
  // App's send to that App.
  it('only what this App sent in the agent\'s name: not the agent\'s own whisper, not in a group the person is not in, not another App\'s', async () => {
    await inRollback(async () => {
      const room = await seedRoom('as8')
      const elsewhere = uid('as8', 13)
      await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','G3',$2)`, [elsewhere, room.alice])
      for (const user of [room.alice, room.agent]) {
        await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,$3)`, [elsewhere, user, user === room.alice ? 'owner' : 'member'])
      }
      // What the agent wrote itself (its own message_send: no App): a whisper here, a message where the person is not.
      const own = async (id: string, chat: string, whisper: boolean) => database.query(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, to_user_ids, content, content_type, client_message_id, is_whisper)
         VALUES ($1,$2,$3,$4,'mine','text',$1,$5)`,
        [id, chat, room.agent, whisper ? [room.alice] : null, whisper],
      )
      const whispered = messageId()
      await own(whispered, room.group, true)
      expect(await helpers(room.owner, whispered, room.group, room.agent)).toMatchObject({ sent: 0, view: 0 })
      const away = messageId()
      await own(away, elsewhere, false)
      expect(await helpers(room.owner, away, elsewhere, room.agent)).toMatchObject({ sent: 0, view: 0 })
      // Another App sent this one in the agent's name: that App reads it back, this one does not.
      const theirs = messageId()
      expect((await send(room, room.owner, room.agent, room.alice, theirs, 'other-app')).error).toBeUndefined()
      expect(await helpers(room.owner, theirs, room.group, room.agent)).toMatchObject({ sent: 0, view: 0 })
      expect(await helpers(room.owner, theirs, room.group, room.agent, 'other-app')).toMatchObject({ sent: 1, view: 1 })
    })
  })

  it('anon cannot call the helpers', async () => {
    await inRollback(async () => {
      const room = await seedRoom('as7')
      for (const sql of ['SELECT * FROM chat.own_agent_sent($1,$2,$3,$4)', 'SELECT * FROM chat.own_agent_sent_view($1,$2,$3,$4)']) {
        expect((await as(room.owner, sql, [messageId(), room.group, room.agent, 'calendar'], 'anon')).error?.code).toBe('42501')
      }
      expect((await as(room.owner, 'SELECT chat.own_agent_app_sends($1,$2,$3)', [room.group, room.agent, 'calendar'], 'anon')).error?.code).toBe('42501')
    })
  })
})
