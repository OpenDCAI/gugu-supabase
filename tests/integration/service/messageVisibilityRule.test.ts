import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Every actor-scoped message reader applies one visibility rule, chat.message_visible_at: can_read_message (through
 * message_visible_to), message_history_as, message_search_as, list_topics_of_chat and activity_metadata_as.
 * The proof changes that rule inside the test transaction and expects every reader to follow it at once; a
 * reader that restates the rule inline keeps answering the old way and fails here. Every case runs inside
 * BEGIN...ROLLBACK, so the changed rule never leaves the test.
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
async function say(chatId: string, sender: string, hour: number, opts: { to?: string[] } = {}): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, created_at)
    VALUES ($1,$2,$3,'visibility needle','text',$4,$5)`, [id, chatId, sender, opts.to ?? null, at(hour)])
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
  await asService()
  return {
    history: history.includes(message),
    search: search.includes(message),
    topicCount: Number(topics.find((row) => row.chat_id === topic)?.message_count ?? -1),
    activity: activity.includes(message) && activity.includes(topicMessage),
    readable,
  }
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
  it('a change to chat.message_visible_at reaches can_read_message, history, search, topic counts and activity at once', async () => {
    const owner = await human('Owner')
    const peer = await human('Peer')
    const agent = await agentOf(owner)
    const group = randomUUID()
    await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','rule',$2)`, [group, owner])
    for (const [user, role] of [[owner, 'owner'], [agent, 'member'], [peer, 'member']]) {
      await database.query('INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,$3)', [group, user, role])
    }
    const message = await say(group, peer, 1)
    const topic = randomUUID()
    await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id, source_chat_id, source_message_id)
      VALUES ($1,'topic','topic',$2,$3,$4)`, [topic, peer, group, message])
    const topicMessage = await say(topic, peer, 2, { to: [agent] })

    // Control: under the shipped rule every reader sees both messages.
    expect(await readers(owner, agent, group, topic, message, topicMessage))
      .toEqual({ history: true, search: true, topicCount: 1, activity: true, readable: true })

    // Tighten the one rule (as a future rule would). Nothing else changes.
    await asService()
    await database.query(`CREATE OR REPLACE FUNCTION chat.message_visible_at(p_floor timestamptz, p_created_at timestamptz,
      p_is_whisper boolean, p_sender_user_id text, p_to_user_ids text[], p_actor text) RETURNS boolean
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT p_sender_user_id IS DISTINCT FROM '${peer}' $$`)
    expect(await readers(owner, agent, group, topic, message, topicMessage))
      .toEqual({ history: false, search: false, topicCount: 0, activity: false, readable: false })
  })
})
