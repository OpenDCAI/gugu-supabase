import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let database: pg.Client
let owner: string
let chat: string
const widget = { v: 2, text: '本周构建：3 过 1 挂', app: 'build-board', view: 'board' }
const encode = (changes: Record<string, unknown> = {}) => JSON.stringify({ ...widget, ...changes })

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Widget tests require a disposable loopback PostgreSQL database')
  }
  database = new pg.Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = randomUUID()
  chat = randomUUID()
  await database.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Widget fixture')", [owner])
  await database.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Widgets',$2)", [chat, owner])
  await database.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [chat, owner])
})
afterEach(async () => { await database.query('ROLLBACK') })

async function post(content: string | null, type = 'widget') {
  const id = randomUUID()
  await database.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type)
    VALUES($1,$2,$3,$4,$5)`, [id, chat, owner, content, type])
  return id
}

async function rejected(sql: string, values: unknown[] = []) {
  await database.query('SAVEPOINT invalid_widget')
  try {
    await expect(database.query(sql, values)).rejects.toMatchObject({ code: '23514', constraint: 'messages_widget_shape' })
  } finally {
    await database.query('ROLLBACK TO SAVEPOINT invalid_widget')
    await database.query('RELEASE SAVEPOINT invalid_widget')
  }
}

describe('widget message SQL contract', () => {
  it('uses plain text for the list, computed preview and recomputation without changing other message types', async () => {
    const id = await post(encode())
    expect((await database.query('SELECT last_message_preview FROM chat.chats WHERE id=$1', [chat])).rows[0].last_message_preview).toBe(widget.text)
    expect((await database.query('SELECT chat.preview(v) AS preview FROM chat.messages_view v WHERE id=$1', [id])).rows[0].preview).toBe(widget.text)
    const text = await post('x'.repeat(101), 'text')
    expect((await database.query('SELECT last_message_preview FROM chat.chats WHERE id=$1', [chat])).rows[0].last_message_preview).toBe('x'.repeat(100))
    await database.query('UPDATE chat.messages SET deleted_at=now() WHERE id=$1', [text])
    expect((await database.query('SELECT last_message_preview FROM chat.chats WHERE id=$1', [chat])).rows[0].last_message_preview).toBe(widget.text)
    expect((await database.query("SELECT chat.message_preview($1,'attachment') AS preview", ['[附件] report.pdf (application/pdf)\n[URL] https://example.test/report.pdf'])).rows[0].preview).toBe('report.pdf')
    expect((await database.query("SELECT chat.message_preview(NULL,'text') AS preview")).rows[0].preview).toBe('')
    expect((await database.query("SELECT chat.message_preview($1,'widget') AS preview", [encode({ text: '**plain** ' + '字'.repeat(190) })])).rows[0].preview).toBe(('**plain** ' + '字'.repeat(190)).slice(0, 100))
  })

  it.each([null, '', '<div>legacy</div>', '{', '{"text":"unfinished', '{"text":"\\u0000"}', '{"text":1e1000000}',
    'null', '[]', '2', '"text"', '{}', '{"text":null}', '{"text":123}', '{"text":[]}', '{"text":{}}', '{"text":""}',
  ])('falls back for malformed or unusable old widget content: %s', async (content) => {
    expect((await database.query("SELECT chat.message_preview($1,'widget') AS preview", [content])).rows[0].preview).toBe('[Widget]')
  })

  it('accepts optional data, unknown keys, Unicode text limits and exact byte limits', async () => {
    await post(encode())
    await post(encode({ data: {}, future: { id: 'nested-is-allowed', title: 'also allowed' } }))
    await post(encode({ text: '😀'.repeat(200) }))
    const dataLimit = encode({ data: { p: 'x'.repeat(4088) } })
    expect((await database.query("SELECT octet_length(($1::json->'data')::text) AS bytes", [dataLimit])).rows[0].bytes).toBe(4096)
    await post(dataLimit)
    const base = encode({ text: '字'.repeat(200) })
    const contentLimit = base + ' '.repeat(6144 - Buffer.byteLength(base))
    expect(Buffer.byteLength(contentLimit)).toBe(6144)
    await post(contentLimit)
    await rejected("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,$4,'widget')", [randomUUID(), chat, owner, contentLimit + ' '])
    // CHECK applies only to widget messages; ordinary content retains its existing contract.
    await post('{not json ' + 'x'.repeat(6144), 'text')
  })

  const invalid = [
    ['SQL null', null], ['bad JSON', '{'], ['JSON null', 'null'], ['array', '[]'],
    ['missing fields', '{}'], ['old widget', '{"id":"old","title":"Old"}'],
    ...['v', 'text', 'app', 'view'].map((field) => {
      const missing: Record<string, unknown> = { ...widget }; delete missing[field]
      return ['missing ' + field, JSON.stringify(missing)]
    }),
    ...[1, '2', null].map((v) => ['wrong version', encode({ v })]),
    ...['', null, 1, [], {}, '字'.repeat(201)].map((text) => ['invalid text', encode({ text })]),
    ...['app', 'view'].flatMap((field) => ['', null, 1, [], {}].map((value) => ['invalid ' + field, encode({ [field]: value })])),
    ...[null, [], 'data', 1, { p: 'x'.repeat(4089) }, { p: '字'.repeat(1363) }].map((data) => ['invalid data', encode({ data })]),
    ...['id', 'title'].map((field) => ['reserved ' + field, encode({ [field]: null })]),
    ['both reserved fields', encode({ id: 'old', title: 'Old' })],
    ['jsonb-invalid escape', '{"v":2,"text":"\\u0000","app":"app","view":"view"}'],
    ['jsonb-invalid number', encode().slice(0, -1) + ',"future":1e1000000}'],
  ] as Array<[string, string | null]>
  it.each(invalid)('rejects %s with the named CHECK instead of a cast exception', async (_name, content) => {
    await rejected("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,$4,'widget')", [randomUUID(), chat, owner, content])
  })

  it('enforces direct member writes and updates even when RLS permits them', async () => {
    await database.query('SET LOCAL ROLE authenticated')
    await database.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner])
    const id = await post(encode())
    await rejected('UPDATE chat.messages SET content=$1 WHERE id=$2', [encode({ text: '' }), id])
    await rejected("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,$4,'widget')", [randomUUID(), chat, owner, '{'])
    await database.query('UPDATE chat.messages SET content=$1 WHERE id=$2', [encode({ text: 'Updated text' }), id])
    await database.query('RESET ROLE')
    expect((await database.query('SELECT content FROM chat.messages WHERE id=$1', [id])).rows[0].content).toBe(encode({ text: 'Updated text' }))
    await database.query('SET LOCAL ROLE service_role')
    await rejected("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,$4,'widget')", [randomUUID(), chat, owner, encode({ title: 'legacy' })])
  })
})
