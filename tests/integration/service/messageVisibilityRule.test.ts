import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Every function that reads messages for an actor applies one visibility rule, chat.message_visible_at:
 * can_read_message (through message_visible_to), message_history_as, message_search_as, list_topics_of_chat,
 * activity_metadata_as, get_agent_join_context, list_unread_locators and mark_unread. The proof changes that rule
 * inside the test transaction and expects every reader to follow it at once; a reader that restates the rule
 * inline keeps answering the old way and fails here. The row policy keeps its own form (it runs as the caller);
 * oneWhisperRule6835 holds it to the same answers. Every case runs inside BEGIN...ROLLBACK, so the changed rule
 * never leaves the test.
 * Run: `GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:<port>/postgres pnpm exec vitest run messageVisibilityRule`
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient

const SINCE = '2026-10-20T00:00:00Z'
const UNTIL = '2026-10-21T00:00:00Z'
const at = (hour: number) => new Date(Date.parse(SINCE) + hour * 3_600_000).toISOString()

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asService() { await database.query('RESET role') }
async function human(name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@visibility-rule.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'visibility rule fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}
async function agentOf(ownerId: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id)
    VALUES ($1,'agent','Assistant',$2,$3)`, [id, ownerId, `dev-${ownerId}`])
  return id
}
async function say(chatId: string, sender: string, hour: number, opts: { to?: string[]; whisper?: boolean } = {}): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, created_at, is_whisper)
    VALUES ($1,$2,$3,'visibility needle','text',$4,$5,$6)`, [id, chatId, sender, opts.to ?? null, at(hour), opts.whisper ?? false])
  return id
}

/** What each reader says about one message (or the topic it lives in), asked by the owner as the agent. */
async function readers(owner: string, agent: string, group: string, topic: string, message: string, topicMessage: string) {
  await asUser(owner)
  const history = (await database.query<{ id: string }>('SELECT id FROM chat.message_history_as($1,$2)', [group, agent])).rows.map((r) => r.id)
  const search = (await database.query<{ id: string }>("SELECT id FROM chat.message_search_as($1,'needle',$2)", [group, agent])).rows.map((r) => r.id)
  const topics = (await database.query<{ chat_id: string; message_count: string }>('SELECT chat_id, message_count FROM chat.list_topics_of_chat($1,$2)', [group, agent])).rows
  const activity = (await database.query<{ page: { events: Array<{ message_id: string }> } }>(
    'SELECT chat.activity_metadata_as($1,$2,$3) AS page', [agent, SINCE, UNTIL])).rows[0]!.page.events.map((e) => e.message_id)
  const readable = (await database.query<{ ok: boolean }>('SELECT chat.can_read_message($1,$2) AS ok', [message, agent])).rows[0]!.ok
  // The owner's own unread views of the group's main stream, and the agent's join context there. Both write, so
  // each is undone before the next reader.
  const unread = (await attempt<{ unread_count: string }>(
    "SELECT unread_count::text FROM chat.list_unread_locators($1) WHERE stream_kind = 'main'", [group])).rows
  const marked = await attempt('SELECT * FROM chat.mark_unread($1)', [group])
  const join = await attempt<{ skipped_before_join: string }>(
    'SELECT skipped_before_join::text FROM identity.get_agent_join_context($1,$2)', [agent, group])
  await asService()
  return {
    history: history.includes(message),
    search: search.includes(message),
    topicCount: Number(topics.find((row) => row.chat_id === topic)?.message_count ?? -1),
    activity: activity.includes(message) && activity.includes(topicMessage),
    readable,
    unread: Number(unread[0]?.unread_count ?? 0),
    markable: marked.error === undefined,
    joinSkipped: Number(join.rows[0]?.skipped_before_join ?? 0),
  }
}

/** Runs one statement and undoes what it wrote; a failure comes back as its message. */
async function attempt<Row = Record<string, unknown>>(sql: string, values: unknown[]): Promise<{ rows: Row[]; error?: string }> {
  await database.query('SAVEPOINT attempt')
  try {
    return { rows: (await database.query<Row>(sql, values)).rows }
  } catch (error) {
    return { rows: [], error: (error as Error).message }
  } finally {
    await database.query('ROLLBACK TO SAVEPOINT attempt')
  }
}

/** A group whose members start unread at zero, as the inbox publishes them. */
async function groupWith(owner: string, members: string[]): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','rule',$2)`, [id, owner])
  for (const user of [owner, ...members]) {
    await database.query('INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,$3)', [id, user, user === owner ? 'owner' : 'member'])
  }
  await database.query(`UPDATE chat.chat_members SET hide_history_before = NULL, inbox_published_at = now(), last_read_seq = 0,
    join_context_shown_at = NULL WHERE chat_id = $1`, [id])
  return id
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('messageVisibilityRule.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => { await database.query('BEGIN') })
afterEach(async () => {
  if (!database) return
  try {
    await asService()
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await database.query('ROLLBACK')
  }
})

describe('one message-visibility rule for every actor-scoped reader', () => {
  it('returns reply privacy for an agent without exposing another pair of whisper participants', async () => {
    const owner = await human('Owner'), other = await human('Other'), outsider = await human('Outsider')
    const agent = await agentOf(owner)
    const group = await groupWith(owner, [other, outsider, agent])
    const incoming = await say(group, other, 1, { to: [agent], whisper: true })
    const outgoing = await say(group, agent, 2, { to: [other], whisper: true })
    const unrelated = await say(group, owner, 3, { to: [other], whisper: true })
    const publicMessage = await say(group, other, 4, { to: [agent] })
    await asUser(owner)
    // Owner-scoped table reads deliberately do not impersonate the agent.
    expect((await database.query('SELECT id FROM chat.messages WHERE id = $1', [incoming])).rows).toEqual([])
    const rows = (await database.query('SELECT id, sender_user_id, to_user_ids, is_whisper FROM chat.message_history_as($1,$2)', [group, agent])).rows
    expect(rows).toEqual(expect.arrayContaining([
      { id: incoming, sender_user_id: other, to_user_ids: [agent], is_whisper: true },
      { id: outgoing, sender_user_id: agent, to_user_ids: [other], is_whisper: true },
      { id: publicMessage, sender_user_id: other, to_user_ids: [agent], is_whisper: false },
    ]))
    expect(rows.some((row) => row.id === unrelated)).toBe(false)
    await asUser(outsider)
    expect((await attempt('SELECT * FROM chat.message_history_as($1,$2)', [group, agent])).error).toMatch(/Not allowed to act as/)
    const outsiderRows = (await database.query('SELECT id FROM chat.message_history_as($1,$2)', [group, outsider])).rows
    expect(outsiderRows).toEqual([{ id: publicMessage }])
  })
  it('a change to chat.message_visible_at reaches every reader at once', async () => {
    const owner = await human('Owner')
    const peer = await human('Peer')
    const agent = await agentOf(owner)
    const chat = await groupWith(owner, [agent, peer])
    const message = await say(chat, peer, 1)
    const topic = randomUUID()
    await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id, source_chat_id, source_message_id)
      VALUES ($1,'topic','topic',$2,$3,$4)`, [topic, peer, chat, message])
    const topicMessage = await say(topic, peer, 2, { to: [agent] })

    // Control: under the shipped rule every reader sees both messages.
    expect(await readers(owner, agent, chat, topic, message, topicMessage)).toEqual({
      history: true, search: true, topicCount: 1, activity: true, readable: true, unread: 1, markable: true, joinSkipped: 1 })

    // Tighten the one rule (as a future rule would). Nothing else changes.
    await asService()
    await database.query(`CREATE OR REPLACE FUNCTION chat.message_visible_at(p_floor timestamptz, p_created_at timestamptz,
      p_is_whisper boolean, p_sender_user_id text, p_to_user_ids text[], p_actor text) RETURNS boolean
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT p_sender_user_id IS DISTINCT FROM '${peer}' $$`)
    expect(await readers(owner, agent, chat, topic, message, topicMessage)).toEqual({
      history: false, search: false, topicCount: 0, activity: false, readable: false, unread: 0, markable: false, joinSkipped: 0 })
  })

  it('the rule stays a plain SQL function, so readers inline it and keep the floor in their own plan', async () => {
    // A SQL function is inlined only if it is not SECURITY DEFINER and sets no configuration; inlined, a reader's
    // floor is an ordinary condition the planner can put in the index scan instead of a call per row.
    const shape = (await database.query<{ lanname: string; provolatile: string; prosecdef: boolean; proconfig: string[] | null }>(
      `SELECT l.lanname, p.provolatile, p.prosecdef, p.proconfig FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
        WHERE p.oid = 'chat.message_visible_at(timestamptz,timestamptz,boolean,text,text[],text)'::regprocedure`)).rows
    expect(shape).toEqual([{ lanname: 'sql', provolatile: 'i', prosecdef: false, proconfig: null }])
    const plan = (await database.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) SELECT m.id FROM chat.messages m
      WHERE m.chat_id = 'x' AND m.deleted_at IS NULL
        AND chat.message_visible_at(now(), m.created_at, m.is_whisper, m.sender_user_id, m.to_user_ids, 'y')`)).rows
      .map((row) => row['QUERY PLAN']).join('\n')
    expect(plan).toMatch(/created_at >= /)
    expect(plan).not.toMatch(/message_visible_at/)
  })

  it('mark_unread refuses a main stream whose every message is before the member\'s floor, as the unread locator sees it', async () => {
    const owner = await human('Owner')
    const late = await human('Late')
    const chat = await groupWith(owner, [late])
    await say(chat, owner, 1)
    await database.query('UPDATE chat.chat_members SET hide_history_before = $3 WHERE chat_id = $1 AND user_id = $2', [chat, late, at(2)])

    await asUser(late)
    expect((await attempt('SELECT * FROM chat.mark_unread($1)', [chat])).error).toMatch(/cannot mark an empty main stream unread/)
    expect((await attempt('SELECT * FROM chat.list_unread_locators($1)', [chat])).rows).toEqual([])
    // Control: the member without a floor can mark it.
    await asUser(owner)
    expect((await attempt('SELECT * FROM chat.mark_unread($1)', [chat])).error).toBeUndefined()
  })

  it('the join context counts the topic lines the agent can page back to through the source chat', async () => {
    const owner = await human('Owner')
    const peer = await human('Peer')
    const agent = await agentOf(owner)
    const chat = await groupWith(owner, [agent, peer])
    const source = await say(chat, peer, 1)
    const topic = randomUUID()
    await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id, source_chat_id, source_message_id)
      VALUES ($1,'topic','topic',$2,$3,$4)`, [topic, peer, chat, source])
    await say(topic, peer, 2)
    await say(topic, peer, 3)
    // The agent joins the topic now; its own row starts there, as in a chat that hides earlier history.
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`, [topic, agent])
    await database.query(`UPDATE chat.chat_members SET hide_history_before = now(), joined_at = now(), last_read_seq = 0,
      join_context_shown_at = NULL WHERE chat_id = $1 AND user_id = $2`, [topic, agent])

    await asUser(owner)
    const history = (await database.query<{ id: string }>('SELECT id FROM chat.message_history_as($1,$2)', [topic, agent])).rows
    expect(history).toHaveLength(2)
    const join = await attempt<{ skipped_before_join: string }>(
      'SELECT skipped_before_join::text FROM identity.get_agent_join_context($1,$2)', [agent, topic])
    expect(join.rows.map((row) => Number(row.skipped_before_join))).toEqual([history.length])
  })
})
