import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 只放进群文件夹的字节(迁移 *_attachment_place_in_folder;gugu#7290 gugu-3 的前置):App 写文件改走新链 —— 上传登记成 blob 以后,
 * chat.file_place_as 在某个文件夹里建一个文件(条目直接指 blob,没有 pointer),chat.file_replace_as 把一个文件换成这份字节(升一版)。
 * 都不发消息、不进「附件」;同一次上传重试回同一个条目;别人的、发过消息的、放到别处的上传都拒。
 * 每条否定配正对照;每条用例 BEGIN…ROLLBACK。
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient
let owner: string
let member: string
let outsider: string
let agent: string

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asServiceRole() {
  await database.query('SET LOCAL role TO service_role')
}
async function asOwner() {
  await database.query('RESET role')
}
async function fails(sql: string, values: unknown[] = []): Promise<string> {
  await database.query('SAVEPOINT expected_failure')
  try {
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT expected_failure')
    const e = error as Error & { hint?: string; code?: string }
    return `${e.message} | hint: ${e.hint ?? ''} | code: ${e.code ?? ''}`
  }
  await database.query('RELEASE SAVEPOINT expected_failure')
  throw new Error(`expected failure, but succeeded: ${sql}`)
}
async function human(name: string): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@file-place-in-folder.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'file-place-in-folder fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}
async function agentOf(ownerId: string, name: string): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, agent_public, device_id)
    VALUES ($1,'agent',$2,$3,true,$4)`, [id, name, ownerId, `dev-${ownerId}`])
  return id
}
async function newGroup(creator: string, initial: string[]): Promise<string> {
  const id = randomUUID()
  await asUser(creator)
  await database.query('SELECT chat.create_gugu_group($1,$2,$3,$4::jsonb)', [
    id, 'File place in folder', creator, JSON.stringify(initial.map((user_id) => ({ user_id, role: 'member' }))),
  ])
  await asOwner()
  return id
}
async function object(chatId: string, by: string, name = 'deck.pptx'): Promise<string> {
  const pointer = `${chatId}/${by}/${randomUUID()}-${name}`
  await asOwner()
  await database.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('workspace',$1)`, [pointer])
  return pointer
}
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
/** A binary made by `by` (a pointer, a 'workspace' blob; written directly, as the server): its item. */
async function binary(chatId: string, by: string): Promise<string> {
  const pointer = await object(chatId, by)
  await asOwner()
  const { rows } = await database.query<{ id: string }>(
    `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, blob_id, size_bytes, source_message_ids, created_by, version)
     VALUES ($1,'file','deck.pptx',$2,chat.file_blob_for_pointer($3,100,$2,$4),100,'{}',$4,1) RETURNING id`, [chatId, PPTX, pointer, by])
  await asOwner()
  return rows[0]!.id
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
/** What the attachments function does once it has read the bytes: an upload registered for `by` (service_role). */
async function upload(by: string, content: string, type = 'image/png', size = 1234): Promise<{ key: string; blob: string }> {
  const key = `staging/${by}/${randomUUID()}`
  await asServiceRole()
  const { rows } = await database.query<{ blob_id: string }>('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5,$6,$7)', [by, key, sha(content), size, type, 640, 480])
  await asOwner()
  return { key, blob: rows[0]!.blob_id }
}
type Item = { id: string; chat_id: string; parent_id: string | null; filename: string; kind: string; blob_id: string | null; pointer: string | null; created_by: string; source_message_ids: string[]; version: number; size_bytes: string; content_type: string }
async function item(id: string): Promise<Item> {
  await asOwner()
  return (await database.query<Item>('SELECT id, chat_id, parent_id, filename, kind, blob_id, chat.file_blob_pointer(blob_id) AS pointer, created_by, source_message_ids, version, size_bytes, content_type FROM chat.workspace_items WHERE id = $1', [id])).rows[0]!
}
type Placed = { id: string; chat_id: string; parent_id: string | null; filename: string; pointer: string | null; version: number; created_by: string; source_message_ids: string[]; path: string; size_bytes: string; content_type: string }
const PLACE = 'SELECT * FROM chat.file_place_as($1,$2,$3,$4,$5,$6)'
async function place(caller: string, key: string, chatId: string, name: string, opts: { as?: string; folder?: string; sources?: string[] } = {}): Promise<Placed> {
  await asUser(caller)
  const { rows } = await database.query<Placed>(PLACE, [key, chatId, opts.as ?? caller, name, opts.folder ?? null, opts.sources ?? null])
  await asOwner()
  return rows[0]!
}
const REPLACE = 'SELECT * FROM chat.file_replace_as($1,$2,$3,$4)'
async function replace(caller: string, key: string, itemId: string, expected: number | null, as: string | null = null) {
  await asUser(caller)
  const { rows } = await database.query<{ id: string; version: number; pointer: string | null; pruned_pointers: string[]; parent_id: string | null; system_role: string | null; path: string }>(REPLACE, [key, itemId, as ?? caller, expected])
  await asOwner()
  return rows[0]!
}
async function messagesIn(chatId: string): Promise<number> {
  await asOwner()
  return Number((await database.query<{ n: string }>('SELECT count(*) AS n FROM chat.messages WHERE chat_id = $1', [chatId])).rows[0]!.n)
}
async function versions(itemId: string) {
  await asOwner()
  return (await database.query<{ n: number; blob_id: string | null; pointer: string | null }>('SELECT n, blob_id, chat.file_blob_pointer(blob_id) AS pointer FROM chat.workspace_item_versions WHERE item_id = $1 ORDER BY n', [itemId])).rows
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('filePlaceInFolder.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human('Owner')
  member = await human('Member')
  outsider = await human('Outsider')
  agent = await agentOf(owner, 'Owner Agent')
})
afterEach(async () => {
  if (!database) return
  try {
    await asOwner()
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await database.query('ROLLBACK')
  }
})

describe('chat.file_place_as:上传放进群文件夹,不发消息', () => {
  it('放在根上:条目指那个 blob、没有 pointer、第 1 版;没发消息、不进「附件」;登记记下了条目;重试回同一个条目', async () => {
    const group = await newGroup(owner, [member])
    const { key, blob } = await upload(member, `doc-${randomUUID()}`, 'application/pdf', 4321)
    const placed = await place(member, key, group, ' report.pdf ', { sources: ['m-1'] })
    expect(placed).toMatchObject({ chat_id: group, parent_id: null, filename: 'report.pdf', pointer: null, version: 1, created_by: member, source_message_ids: ['m-1'], path: 'report.pdf', size_bytes: '4321', content_type: 'application/pdf' })
    expect((await item(placed.id)).blob_id).toBe(blob)
    expect(await messagesIn(group)).toBe(0)
    expect((await database.query<{ item_id: string; message_id: string | null }>('SELECT item_id, message_id FROM chat.file_blob_uploads WHERE staging_key = $1', [key])).rows[0]).toEqual({ item_id: placed.id, message_id: null })
    const again = await place(member, key, group, 'report.pdf')
    expect(again.id).toBe(placed.id)
    expect((await database.query('SELECT 1 FROM chat.workspace_items WHERE chat_id = $1 AND kind = $2', [group, 'file'])).rowCount).toBe(1)
  })

  it('放进子文件夹(按路径);agent 代主人放:作者是 agent', async () => {
    const group = await newGroup(owner, [member, agent])
    await asUser(owner)
    await database.query('SELECT * FROM chat.workspace_mkdir_as($1,$2,$3)', [group, owner, 'specs'])
    const { key } = await upload(owner, `doc-${randomUUID()}`, 'application/pdf')
    const placed = await place(owner, key, group, 'a.pdf', { as: agent, folder: 'specs' })
    expect(placed).toMatchObject({ path: 'specs/a.pdf', created_by: agent })
    expect(placed.parent_id).not.toBeNull()
  })

  it('拒:不在会话里、别人的上传、发过消息的上传、放到别的会话去的上传、空名字;对照:自己的、在会话里的放得进', async () => {
    const group = await newGroup(owner, [member])
    const other = await newGroup(member, [outsider])
    const mine = await upload(member, `doc-${randomUUID()}`, 'application/pdf')
    await asUser(outsider)
    expect(await fails(PLACE, [mine.key, group, outsider, 'x.pdf', null, null])).toMatch(/not a chat you are a member of/)
    await asUser(owner)
    expect(await fails(PLACE, [mine.key, group, owner, 'x.pdf', null, null])).toMatch(/hint: attachment_upload_not_found/)
    await asUser(member)
    expect(await fails(PLACE, [mine.key, group, member, '  ', null, null])).toMatch(/file name is required/)
    const placed = await place(member, mine.key, group, 'x.pdf')
    await asUser(member)
    expect(await fails(PLACE, [mine.key, other, member, 'x.pdf', null, null])).toMatch(/hint: attachment_upload_used/)
    expect(placed.chat_id).toBe(group)
    const sent = await upload(member, `pic-${randomUUID()}`)
    await asUser(member)
    await database.query('SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5,$6,NULL,NULL,false,false)', [sent.key, randomUUID(), group, member, 'pic.png', []])
    expect(await fails(PLACE, [sent.key, group, member, 'pic.png', null, null])).toMatch(/hint: attachment_upload_used/)
  })
})

describe('chat.file_replace_as:文件换成这份字节,升一版', () => {
  it('新链的文件:第 2 版指新 blob,历史里两版都在,updated_at 跟着换;版本对不上、同样的字节都拒;重试回同一版', async () => {
    const group = await newGroup(owner, [member])
    const first = await upload(member, `v1-${randomUUID()}`, 'application/pdf', 100)
    const placed = await place(member, first.key, group, 'a.pdf')
    const same = await upload(member, `v1-${randomUUID()}`, 'application/pdf', 100)
    await asOwner()
    await database.query('UPDATE chat.file_blob_uploads SET blob_id = $1 WHERE staging_key = $2', [first.blob, same.key])
    await asUser(member)
    expect(await fails(REPLACE, [same.key, placed.id, member, 1])).toMatch(/content the file already has/)
    const second = await upload(member, `v2-${randomUUID()}`, 'application/pdf', 200)
    await asUser(member)
    expect(await fails(REPLACE, [second.key, placed.id, member, 7])).toMatch(/version conflict: expected 7, got 1 \| hint: workspace_version_conflict/)
    // 换内容前把 updated_at 拨到一个固定的旧值(关掉触发器写):两版都在 OSS、都没有 pointer,换了以后它得变。
    await asOwner()
    await database.query('SET LOCAL session_replication_role = replica')
    await database.query(`UPDATE chat.workspace_items SET updated_at = '2020-01-01T00:00:00Z' WHERE id = $1`, [placed.id])
    await database.query('SET LOCAL session_replication_role = origin')
    const replaced = await replace(member, second.key, placed.id, 1)
    expect(replaced).toMatchObject({ id: placed.id, version: 2, pointer: null, parent_id: null, system_role: null, path: 'a.pdf' })
    expect((await database.query<{ t: Date }>('SELECT updated_at AS t FROM chat.workspace_items WHERE id = $1', [placed.id])).rows[0]!.t.toISOString())
      .not.toBe('2020-01-01T00:00:00.000Z')
    expect(await item(placed.id)).toMatchObject({ blob_id: second.blob, version: 2, size_bytes: '200' })
    expect(await versions(placed.id)).toEqual([{ n: 1, blob_id: first.blob, pointer: null }, { n: 2, blob_id: second.blob, pointer: null }])
    expect((await replace(member, second.key, placed.id, 1)).version).toBe(2)
    expect(await messagesIn(group)).toBe(0)
  })

  it('老的 pointer 文件换成新链的字节:pointer 清空、指 blob;第 1 版照旧留着它的 pointer', async () => {
    const group = await newGroup(owner, [member])
    const old = await binary(group, member)
    const before = await item(old)
    const next = await upload(member, `v2-${randomUUID()}`, PPTX, 300)
    await replace(member, next.key, old, 1)
    expect(await item(old)).toMatchObject({ pointer: null, blob_id: next.blob, version: 2 })
    expect(await versions(old)).toEqual([{ n: 1, blob_id: before.blob_id, pointer: before.pointer }, { n: 2, blob_id: next.blob, pointer: null }])
  })

  it('拒:不在会话里;上传换到别的条目上以后不能再拿来换这个', async () => {
    const group = await newGroup(owner, [member])
    const a = await place(member, (await upload(member, `a-${randomUUID()}`)).key, group, 'a.png')
    const b = await place(member, (await upload(member, `b-${randomUUID()}`)).key, group, 'b.png')
    const next = await upload(member, `n-${randomUUID()}`)
    await asUser(outsider)
    expect(await fails(REPLACE, [next.key, a.id, outsider, 1])).toMatch(/workspace|member/)
    await replace(member, next.key, a.id, 1)
    await asUser(member)
    expect(await fails(REPLACE, [next.key, b.id, member, 1])).toMatch(/hint: attachment_upload_used/)
  })
})

const COMMIT = 'SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5,$6,NULL,NULL,false,$7,NULL,$8)'
async function commitWith(caller: string, key: string, chatId: string, name: string, caption: string | null, opts: { to?: string[]; whisper?: boolean } = {}) {
  await asUser(caller)
  const { rows } = await database.query<{ id: string; content: string; file_item_id: string | null; file_version: number | null }>(COMMIT, [key, randomUUID(), chatId, caller, name, opts.to ?? [], opts.whisper ?? false, caption])
  await asOwner()
  return rows[0]!
}
const SEND = 'SELECT * FROM chat.send_message_idempotent($1,$2,$3,$4,$5,$6,NULL,NULL,false,false,NULL,$7,$8,NULL,NULL)'

describe('图配文字:提交带说明,正文 = 信封 + [Caption] + 说明,核验认这个形状', () => {
  it('说明去掉首尾空白接在信封后面;空白说明 = 没有说明', async () => {
    const group = await newGroup(owner, [member])
    const withCaption = await commitWith(member, (await upload(member, `a-${randomUUID()}`, 'image/png', 1234)).key, group, 'a.png', '  看这张\n第二行 ')
    expect(withCaption.content).toBe('[附件] a.png (image/png)\n[Size] 1234\n[Kind] image\n[Caption]\n看这张\n第二行')
    const blank = await commitWith(member, (await upload(member, `b-${randomUUID()}`, 'image/png', 1234)).key, group, 'b.png', ' \n ')
    expect(blank.content).toBe('[附件] b.png (image/png)\n[Size] 1234\n[Kind] image')
  })

  it('说明被篡改,核验不通过:首尾带空白、空说明、信封换了名字;对照:规规矩矩的信封 + 说明过得去;发出后改说明也不行', async () => {
    const group = await newGroup(owner, [member])
    const sent = await commitWith(member, (await upload(member, `c-${randomUUID()}`, 'image/png', 1234)).key, group, 'c.png', null)
    await asOwner()
    const envelope = (await database.query<{ e: string }>('SELECT chat.workspace_version_envelope($1, $2) AS e', [sent.file_item_id, sent.file_version])).rows[0]!.e
    await asUser(member)
    for (const forged of [`${envelope}\n[Caption]\n 前面有空格`, `${envelope}\n[Caption]\n`, `${envelope}\n[Caption]\n后面有空格 `, envelope.replace('c.png', 'evil.png') + '\n[Caption]\n说明']) {
      expect(await fails(SEND, [randomUUID(), group, member, [], forged, 'attachment', sent.file_item_id, sent.file_version])).toMatch(/hint: message_file_envelope/)
    }
    const ok = await database.query<{ content: string }>(SEND, [randomUUID(), group, member, [], `${envelope}\n[Caption]\n同一个文件,再说一句`, 'attachment', sent.file_item_id, sent.file_version])
    expect(ok.rows[0]!.content).toBe(`${envelope}\n[Caption]\n同一个文件,再说一句`)
    expect(await fails('UPDATE chat.messages SET content = $1 WHERE id = $2', [`${envelope}\n[Caption]\n改过的说明`, sent.id])).toMatch(/hint: message_file_fixed/)
  })

  it('悄悄话也能带说明;转发照抄原来的说明', async () => {
    const group = await newGroup(owner, [member, outsider])
    const other = await newGroup(member, [outsider])
    const whisper = await commitWith(owner, (await upload(owner, `w-${randomUUID()}`, 'image/png', 1234)).key, group, 'w.png', '只给你看', { to: [member], whisper: true })
    expect(whisper.content).toBe('[附件] w.png (image/png)\n[Size] 1234\n[Kind] image\n[Caption]\n只给你看')
    const open = await commitWith(member, (await upload(member, `o-${randomUUID()}`, 'image/png', 1234)).key, group, 'o.png', '大家看')
    await asUser(member)
    const { rows } = await database.query<{ content: string }>('SELECT * FROM chat.attachment_forward($1,$2,$3,$4)', [open.id, randomUUID(), other, member])
    await asOwner()
    expect(rows[0]!.content).toBe('[附件] o.png (image/png)\n[Size] 1234\n[Kind] image\n[Caption]\n大家看')
  })
})

describe('代主人发文件给好友(message_send_file_as_owner)也走新链', () => {
  const OWNER_SEND = 'SELECT chat.send_friend_file_as_owner($1,$2,$3,$4,$5,$6) AS r'
  async function befriend(a: string, b: string) {
    await asOwner()
    await database.query('INSERT INTO identity.friendships(user_a_id,user_b_id) VALUES (LEAST($1,$2),GREATEST($1,$2))', [a, b])
  }

  it('发在主人和好友的私聊里、发送者是主人、指私聊「附件」里的条目、带说明;记下是哪个 agent;同一请求重放回同一条,换了上传或说明就冲突', async () => {
    await befriend(owner, member)
    const { key, blob } = await upload(owner, `o-${randomUUID()}`, 'application/pdf', 4321)
    await asUser(owner)
    const sent = (await database.query<{ r: { chat_id: string; message_id: string; sender_user_id: string; sent_by_agent: boolean } }>(OWNER_SEND, [agent, member, key, 'plan.pdf', 'req-1', ' 给你 '])).rows[0]!.r
    expect(sent).toMatchObject({ sender_user_id: owner, sent_by_agent: true })
    await asOwner()
    const row = (await database.query<{ chat_id: string; sender_user_id: string; to_user_ids: string[]; content: string; file_item_id: string }>(
      'SELECT chat_id, sender_user_id, to_user_ids, content, file_item_id FROM chat.messages WHERE id = $1', [sent.message_id])).rows[0]!
    expect(row).toMatchObject({ chat_id: sent.chat_id, sender_user_id: owner, to_user_ids: [member], content: '[附件] plan.pdf (application/pdf)\n[Size] 4321\n[Kind] file\n[Caption]\n给你' })
    expect((await item(row.file_item_id)).blob_id).toBe(blob)
    expect((await database.query<{ agent_user_id: string }>('SELECT agent_user_id FROM chat.message_agent_sends WHERE message_id = $1', [sent.message_id])).rows[0]!.agent_user_id).toBe(agent)
    await asUser(owner)
    expect((await database.query<{ r: { message_id: string } }>(OWNER_SEND, [agent, member, key, 'plan.pdf', 'req-1', '给你'])).rows[0]!.r.message_id).toBe(sent.message_id)
    const other = await upload(owner, `p-${randomUUID()}`, 'application/pdf')
    await asUser(owner)
    expect(await fails(OWNER_SEND, [agent, member, other.key, 'plan.pdf', 'req-1', null])).toMatch(/Idempotency conflict/)
    expect(await fails(OWNER_SEND, [agent, member, key, 'plan.pdf', 'req-1', '换一句'])).toMatch(/Idempotency conflict/)
  })

  it('拒:不是好友、别人的上传、别人的 agent;对照:好友、自己的上传、自己的 agent 发得出去', async () => {
    await befriend(owner, member)
    const mine = await upload(owner, `m-${randomUUID()}`, 'application/pdf')
    const theirs = await upload(member, `t-${randomUUID()}`, 'application/pdf')
    const theirAgent = await agentOf(member, 'Member Agent')
    await asUser(owner)
    expect(await fails(OWNER_SEND, [agent, outsider, mine.key, 'a.pdf', 'req-a', null])).toMatch(/not an owner friend/)
    expect(await fails(OWNER_SEND, [theirAgent, member, mine.key, 'a.pdf', 'req-d', null])).toMatch(/Agent is not owned by this account .*code: 42501/)
    expect(await fails(OWNER_SEND, [agent, member, theirs.key, 'a.pdf', 'req-b', null])).toMatch(/hint: attachment_upload_not_found/)
    expect((await database.query<{ r: { sent_by_agent: boolean } }>(OWNER_SEND, [agent, member, mine.key, 'a.pdf', 'req-c', null])).rows[0]!.r.sent_by_agent).toBe(true)
  })
})

describe('权限', () => {
  it('两个入口给 authenticated,anon 不行;消费登记的内部函数谁都不能直接调', async () => {
    await asOwner()
    const { rows } = await database.query<{ fn: string; anon: boolean; auth: boolean }>(`
      SELECT p.proname AS fn, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'chat' AND p.proname IN ('file_place_as', 'file_replace_as', 'file_upload_take') ORDER BY 1`)
    expect(rows).toEqual([
      { fn: 'file_place_as', anon: false, auth: true },
      { fn: 'file_replace_as', anon: false, auth: true },
      { fn: 'file_upload_take', anon: false, auth: false },
    ])
  })
})
