import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * chat.activity_metadata_as: when which message appeared in which of an actor's chats, never what it said.
 * The actor is a person or one of their agents (chat.is_acting_as). Agents have no account revisions, so the
 * answer comes from the messages themselves, rechecked against the actor's current membership, history floor,
 * whisper visibility and deletion. Every negative assertion has a positive control; every case runs inside
 * BEGIN...ROLLBACK.
 * Run: `GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:<port>/postgres pnpm exec vitest run activityMetadataAs`
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
interface ActivityEvent {
  revision: number
  kind: string
  occurred_at: string
  chat_id: string
  message_id: string
  sender_user_id?: string
  thread_root_id?: string
}
interface ActivityPage {
  events: ActivityEvent[]
  next_revision: number | null
  through_revision: number
  coverage: Record<string, unknown>
}

let database: DatabaseClient
let owner: string
let peer: string
let stranger: string
let agent: string
let group: string

const SINCE = '2026-10-20T00:00:00Z'
const UNTIL = '2026-10-21T00:00:00Z'
const at = (hour: number) => new Date(Date.parse(SINCE) + hour * 3_600_000).toISOString()

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asAnon() {
  await database.query('SET LOCAL role TO anon')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'anon' })])
}
async function asService() { await database.query('RESET role') }
async function fails(sql: string, values: unknown[] = []): Promise<string> {
  await database.query('SAVEPOINT expected_failure')
  try {
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT expected_failure')
    return String((error as Error).message)
  }
  await database.query('RELEASE SAVEPOINT expected_failure')
  throw new Error(`expected failure, but succeeded: ${sql}`)
}
async function human(name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@activity-metadata.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'activity metadata fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}
async function agentOf(ownerId: string, name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id)
    VALUES ($1,'agent',$2,$3,$4)`, [id, name, ownerId, `dev-${ownerId}`])
  return id
}
/** A group with its members put in directly, as the server does; the first member is the creator. */
async function groupOf(members: string[]): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','activity',$2)`, [id, members[0]])
  for (const [i, user] of members.entries()) {
    await database.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,$3)`, [id, user, i === 0 ? 'owner' : 'member'])
  }
  return id
}
async function say(chatId: string, sender: string, hour: number, opts: { to?: string[]; whisper?: boolean; content?: string } = {}): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, is_whisper, created_at)
    VALUES ($1,$2,$3,$4,'text',$5,$6,$7)`, [id, chatId, sender, opts.content ?? 'SECRET BODY', opts.to ?? null, opts.whisper ?? false, at(hour)])
  return id
}
async function activity(caller: string, actor: string, args: { chat?: string; after?: number; through?: number; limit?: number; since?: string; until?: string } = {}): Promise<ActivityPage> {
  await asUser(caller)
  const { rows } = await database.query<{ page: ActivityPage }>(
    'SELECT chat.activity_metadata_as($1,$2,$3,$4,$5,$6,$7) AS page',
    [actor, args.since ?? SINCE, args.until ?? UNTIL, args.chat ?? null, args.after ?? 0, args.through ?? null, args.limit ?? 50])
  await asService()
  return rows[0]!.page
}
const ids = (page: ActivityPage) => page.events.map((event) => event.message_id)

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('activityMetadataAs.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human('Owner')
  peer = await human('Peer')
  stranger = await human('Stranger')
  agent = await agentOf(owner, 'Assistant')
  group = await groupOf([owner, agent, peer])
})
afterEach(async () => {
  if (!database) return
  try {
    await asService()
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await database.query('ROLLBACK')
  }
})

describe('chat.activity_metadata_as', () => {
  it("answers for an agent from its chats' messages, with identifiers and times only", async () => {
    const first = await say(group, peer, 1)
    const second = await say(group, owner, 2)
    const page = await activity(owner, agent)
    expect(page.events).toEqual([
      { revision: expect.any(Number), kind: 'message_created', occurred_at: expect.any(String), chat_id: group, message_id: first, sender_user_id: peer },
      { revision: expect.any(Number), kind: 'message_created', occurred_at: expect.any(String), chat_id: group, message_id: second, sender_user_id: owner },
    ])
    expect(Date.parse(page.events[0]!.occurred_at)).toBe(Date.parse(at(1)))
    expect(page.events[0]!.revision).toBeLessThan(page.events[1]!.revision)
    expect(JSON.stringify(page)).not.toContain('SECRET')
    expect(page).toMatchObject({ next_revision: null, coverage: { scope: 'actor_visible_chat_messages', actor_user_id: agent } })
    // The agent has no revision journal of its own; the answer above does not depend on one.
    const { rows } = await database.query<{ n: string }>('SELECT count(*) AS n FROM chat.account_revisions WHERE user_id = $1', [agent])
    expect(Number(rows[0]!.n)).toBe(0)
  })

  it('rechecks the history floor, whispers and deletion now (each with a visible control)', async () => {
    const beforeFloor = await say(group, peer, 1)
    const afterFloor = await say(group, peer, 3)
    const whisperToOwner = await say(group, peer, 4, { to: [owner], whisper: true })
    const whisperToAgent = await say(group, peer, 5, { to: [agent], whisper: true })
    const deleted = await say(group, peer, 6)
    const kept = await say(group, peer, 7)
    await database.query('UPDATE chat.chat_members SET hide_history_before = $3 WHERE chat_id = $1 AND user_id = $2', [group, agent, at(2)])
    await database.query('UPDATE chat.messages SET deleted_at = now() WHERE id = $1', [deleted])
    expect(ids(await activity(owner, agent))).toEqual([afterFloor, whisperToAgent, kept])
    // Controls: the owner, with no floor and as the other whisper's recipient, sees what the agent may not.
    expect(ids(await activity(owner, owner))).toEqual([beforeFloor, afterFloor, whisperToOwner, kept])
  })

  it('lists only chats the actor is in now; asking about a chat it cannot see is refused, not empty', async () => {
    const elsewhere = await groupOf([peer, stranger])
    const outside = await say(elsewhere, peer, 1)
    const inside = await say(group, peer, 2)
    expect(ids(await activity(owner, agent))).toEqual([inside])
    await asUser(owner)
    expect(await fails('SELECT chat.activity_metadata_as($1,$2,$3,$4)', [agent, SINCE, UNTIL, elsewhere])).toMatch(/Not allowed to read activity of chat/)
    expect(ids(await activity(peer, peer, { chat: elsewhere }))).toEqual([outside])
    await database.query('DELETE FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2', [group, agent])
    expect(ids(await activity(owner, agent))).toEqual([])
    await asUser(owner)
    expect(await fails('SELECT chat.activity_metadata_as($1,$2,$3,$4)', [agent, SINCE, UNTIL, group])).toMatch(/Not allowed to read activity of chat/)
    expect(ids(await activity(owner, owner, { chat: group }))).toEqual([inside])
  })

  it('covers a topic through the actor’s own participation, or by id through the source chat', async () => {
    const source = await say(group, peer, 1)
    const topic = randomUUID()
    await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id, source_chat_id, source_message_id)
      VALUES ($1,'topic','topic',$2,$3,$4)`, [topic, peer, group, source])
    const unaddressed = await say(topic, peer, 2)
    expect(ids(await activity(owner, agent))).toEqual([source])
    expect(ids(await activity(owner, agent, { chat: topic }))).toEqual([unaddressed])
    const addressed = await say(topic, peer, 3, { to: [agent] })
    expect(ids(await activity(owner, agent))).toEqual([source, unaddressed, addressed])
  })

  it('pages under a fixed watermark; a later message appears in a new query', async () => {
    const one = await say(group, peer, 1)
    const two = await say(group, peer, 2)
    const first = await activity(owner, agent, { limit: 1 })
    expect(ids(first)).toEqual([one])
    expect(first.next_revision).toBe(first.events[0]!.revision)
    const late = await say(group, peer, 3)
    const second = await activity(owner, agent, { limit: 1, after: first.next_revision!, through: first.through_revision })
    expect(ids(second)).toEqual([two])
    expect(second.next_revision).toBeNull()
    expect(second.through_revision).toBe(first.through_revision)
    expect(ids(await activity(owner, agent))).toEqual([one, two, late])
    await asUser(owner)
    expect(await fails('SELECT chat.activity_metadata_as($1,$2,$3,NULL,$4,$5)', [agent, SINCE, UNTIL, 5, 4])).toMatch(/outside the message sequence/)
    expect(await fails('SELECT chat.activity_metadata_as($1,$2,$3,NULL,0,$4)', [agent, SINCE, UNTIL, Number.MAX_SAFE_INTEGER])).toMatch(/outside the message sequence/)
  })

  it('uses a half-open time window and refuses an invalid range or page size', async () => {
    const start = await say(group, peer, 0)
    await say(group, peer, 24)
    expect(ids(await activity(owner, agent))).toEqual([start])
    await asUser(owner)
    expect(await fails('SELECT chat.activity_metadata_as($1,$2,$3)', [agent, UNTIL, SINCE])).toMatch(/finite, increasing time range/)
    expect(await fails("SELECT chat.activity_metadata_as($1,$2,'infinity')", [agent, SINCE])).toMatch(/finite, increasing time range/)
    expect(await fails('SELECT chat.activity_metadata_as($1,$2,$3,NULL,0,NULL,201)', [agent, SINCE, UNTIL])).toMatch(/page size/)
  })

  it('only the actor or its owner may ask; anonymous callers have no access (control: the owner reads)', async () => {
    const message = await say(group, peer, 1)
    await asUser(stranger)
    expect(await fails('SELECT chat.activity_metadata_as($1,$2,$3)', [agent, SINCE, UNTIL])).toMatch(/Not allowed to read activity as/)
    expect(await fails('SELECT chat.activity_metadata_as($1,$2,$3)', [owner, SINCE, UNTIL])).toMatch(/Not allowed to read activity as/)
    await asAnon()
    expect(await fails('SELECT chat.activity_metadata_as($1,$2,$3)', [agent, SINCE, UNTIL])).toMatch(/permission denied/)
    expect(ids(await activity(owner, agent))).toEqual([message])
  })
})
