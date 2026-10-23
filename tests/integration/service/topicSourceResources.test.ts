import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: Client
let owner: string, reader: string, outsider: string, agentOwner: string, agent: string, topicOnlyAgent: string, readerAgent: string
let source: string, topic: string, other: string

async function admin() { await db.query('RESET ROLE') }
async function user(id: string) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',json_build_object('sub',$1::text,'role','authenticated')::text,true)`, [id])
}
async function rpc(id: string, sql: string, values: unknown[] = []) {
  await user(id)
  const result = await db.query(sql, values)
  await admin()
  return result.rows
}
async function denied(id: string, sql: string, values: unknown[] = []) {
  await user(id)
  await db.query('SAVEPOINT denied')
  try {
    await db.query(sql, values)
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT denied')
    await admin()
    return { message: (error as Error).message, hint: (error as { hint?: string }).hint }
  }
  throw new Error('expected resource access to be denied')
}
async function room(kind: 'group' | 'dm', members: string[]) {
  const id = randomUUID()
  await db.query('INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,$2,$3,$4)', [id, kind, kind === 'group' ? 'resource fixture' : null, owner])
  for (const member of [owner, ...members]) await db.query('INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,$3)', [id, member, member === owner ? 'owner' : 'member'])
  return id
}
async function topicIn(chat: string) {
  const anchor = randomUUID(), id = randomUUID()
  await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'source message')`, [anchor, chat, owner])
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id,source_message_id) VALUES ($1,'topic','topic',$2,$3,$4)`, [id, owner, chat, anchor])
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner')`, [id, owner])
  return id
}
async function staged(uploader = owner) {
  const blob = randomUUID(), hash = randomUUID().replaceAll('-', '').repeat(2)
  const key = `staging/${uploader}/${randomUUID()}`
  await db.query(`INSERT INTO chat.file_blobs(id,bucket_id,object_name,sha256,size_bytes,content_type)
    VALUES ($1,'oss',$2,$3,3,'text/plain')`, [blob, hash.slice(0, 2) + '/' + hash, hash])
  await db.query('INSERT INTO chat.file_blob_uploads(staging_key,uploader,blob_id) VALUES ($1,$2,$3)', [key, uploader, blob])
  return { key, blob }
}
async function attached(chat = topic, whisper = false) {
  const upload = await staged(), message = randomUUID()
  const [sent] = await rpc(owner, 'SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5,$6,NULL,NULL,false,$7)',
    [upload.key, message, chat, owner, 'proof.txt', whisper ? [reader] : [], whisper])
  return { sent, upload, message }
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('topic resources require disposable loopback PostgreSQL')
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  // Storage API sets this before remove(); RLS still governs the tested actor.
  await db.query("SELECT set_config('storage.allow_delete_query','true',true)")
  ;[owner, reader, outsider, agentOwner, agent, topicOnlyAgent, readerAgent] = Array.from({ length: 7 }, randomUUID)
  for (const id of [owner, reader, outsider, agentOwner]) await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`, [id, `${id}@topic-resource.example.test`])
  for (const [id, parent] of [[agent, agentOwner], [topicOnlyAgent, owner], [readerAgent, reader]]) {
    const device = 'topic-resource-' + parent
    await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES ($1,$2,'fixture','fixture','linux')`, [device, parent])
    await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES ($1,'agent','resource agent',$2,$3)`, [id, parent, device])
  }
  source = await room('group', [reader, agent]); other = await room('group', [outsider])
  topic = await topicIn(source)
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'member')`, [topic, topicOnlyAgent])
})
afterEach(async () => {
  if (!db) return
  try { await admin(); await db.query('SET CONSTRAINTS ALL IMMEDIATE') }
  finally { await db.query('ROLLBACK') }
})

describe('topics use one source resource container', () => {
  it('topic UUID and public number have identical actor-visible facts and resource denials', async () => {
    const number = String((await db.query('SELECT public_id FROM chat.chats WHERE id=$1', [topic])).rows[0].public_id)
    const facts = (caller: string, address: string, actor: string) => rpc(caller, 'SELECT * FROM chat.chat_facts($1,$2)', [address, actor])
    for (const [caller, actor] of [[reader, reader], [agentOwner, agent]]) {
      const byId = await facts(caller, topic, actor), byNumber = await facts(caller, number, actor)
      expect(byId).toHaveLength(1); expect(byNumber).toEqual(byId)
      expect(byNumber[0]).toMatchObject({ id: topic, kind: 'topic', source_chat_id: source, public_id: Number(number) })
      for (const result of [byId, byNumber]) {
        expect(await rpc(caller, 'SELECT * FROM chat.workspace_status_as($1,$2)', [result[0].id, actor])).toEqual([{ total: 0, documents: 0, files: 0 }])
      }
      expect((await db.query('SELECT chat.is_chat_member($1,$2) AS participant', [topic, actor])).rows[0].participant).toBe(false)
    }
    expect(await facts(outsider, topic, outsider)).toEqual([])
    expect(await facts(outsider, number, outsider)).toEqual([])
    // Existing facts visibility includes the caller's source membership, but
    // resource access still requires the delegated actor's own source seat.
    const delegatedId = await facts(owner, topic, topicOnlyAgent)
    expect(delegatedId).toHaveLength(1)
    expect(await facts(owner, number, topicOnlyAgent)).toEqual(delegatedId)
    for (const address of [topic, number]) {
      const result = await facts(owner, address, topicOnlyAgent)
      expect((await denied(owner, 'SELECT * FROM chat.workspace_status_as($1,$2)', [result[0].id, topicOnlyAgent])).hint).toBe('workspace_not_member')
      expect((await denied(reader, 'SELECT * FROM chat.chat_facts($1,$2)', [address, agent])).message).toMatch(/Not allowed to act as/)
    }
    for (const address of [randomUUID(), '9999999999', '999999999999999999999999999', '1e3']) {
      expect(await facts(reader, address, reader)).toEqual([])
    }
    await rpc(owner, 'SELECT chat.remove_group_member_as($1,$2,$3)', [source, agent, owner])
    expect(await facts(agentOwner, topic, agent)).toEqual([])
    expect(await facts(agentOwner, number, agent)).toEqual([])
  })

  it('adding an owned agent to a topic joins the source normally; leaving the topic retains file access', async () => {
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [topic, topicOnlyAgent])
    const [doc] = await rpc(reader, 'SELECT * FROM chat.workspace_create_document_as($1,$2,$3)', [source, reader, 'shared.md'])
    const [joined] = await rpc(owner, 'SELECT chat.add_group_agent($1,$2,NULL,$3) AS result', [topic, topicOnlyAgent, owner])
    expect(joined.result.status).toBe('joined')
    expect((await db.query('SELECT chat.is_chat_member($1,$3) AS source,chat.is_chat_member($2,$3) AS topic', [source, topic, topicOnlyAgent])).rows[0]).toEqual({ source: true, topic: true })
    expect((await rpc(owner, 'SELECT id FROM chat.workspace_get_as($1,$2)', [doc.id, topicOnlyAgent]))[0].id).toBe(doc.id)
    await rpc(owner, 'SELECT chat.remove_group_member_as($1,$2,$3)', [topic, topicOnlyAgent, owner])
    expect((await db.query('SELECT chat.is_chat_member($1,$3) AS source,chat.is_chat_member($2,$3) AS topic', [source, topic, topicOnlyAgent])).rows[0]).toEqual({ source: true, topic: false })
    expect((await rpc(owner, 'SELECT id FROM chat.workspace_get_as($1,$2)', [doc.id, topicOnlyAgent]))[0].id).toBe(doc.id)
  })

  it('topic agent admission preserves source approval and capacity gates', async () => {
    await db.query('UPDATE chat.chats SET agent_join_approval=true WHERE id=$1', [source])
    const [pending] = await rpc(reader, 'SELECT chat.add_group_agent($1,$2,NULL,$3) AS result', [topic, readerAgent, reader])
    expect(pending.result).toMatchObject({ status: 'pending_approval', chat_id: source })
    expect((await db.query('SELECT chat.is_chat_member($1,$3) AS source,chat.is_chat_member($2,$3) AS topic', [source, topic, readerAgent])).rows[0]).toEqual({ source: false, topic: false })
    await rpc(owner, 'SELECT chat.decide_group_join($1,true,$2)', [pending.result.request_id, owner])
    await rpc(reader, 'SELECT chat.add_group_agent($1,$2,NULL,$3)', [topic, readerAgent, reader])
    expect((await db.query('SELECT chat.is_chat_member($1,$3) AS source,chat.is_chat_member($2,$3) AS topic', [source, topic, readerAgent])).rows[0]).toEqual({ source: true, topic: true })
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [topic, topicOnlyAgent])
    await db.query('UPDATE chat.chats SET max_members=(SELECT count(*) FROM chat.chat_members WHERE chat_id=$1),agent_join_approval=false WHERE id=$1', [source])
    expect((await denied(owner, 'SELECT chat.add_group_agent($1,$2,NULL,$3)', [topic, topicOnlyAgent, owner])).message).toBe('member_limit_reached')
    expect((await db.query('SELECT chat.is_chat_member($1,$2) AS member', [source, topicOnlyAgent])).rows[0].member).toBe(false)
  })

  it('an agent opening or speaking in a topic obtains its real source seat', async () => {
    const anchor = (await db.query('SELECT source_message_id FROM chat.chats WHERE id=$1', [topic])).rows[0].source_message_id
    const [opened] = await rpc(owner, 'SELECT * FROM chat.create_topic($1,$2,$3,NULL,$4)', [source, anchor, 'agent opens', topicOnlyAgent])
    expect(opened.source_chat_id).toBe(source)
    expect((await db.query('SELECT chat.is_chat_member($1,$2) AS member', [source, topicOnlyAgent])).rows[0].member).toBe(true)
    await rpc(reader, `INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'agent joins by speaking')`, [randomUUID(), topic, readerAgent])
    expect((await db.query('SELECT chat.is_chat_member($1,$3) AS source,chat.is_chat_member($2,$3) AS topic', [source, topic, readerAgent])).rows[0]).toEqual({ source: true, topic: true })
  })

  it('nonparticipants list/create folders and documents in the source without becoming participants', async () => {
    const [folder] = await rpc(reader, 'SELECT * FROM chat.workspace_mkdir_as($1,$2,$3)', [topic, reader, 'Notes'])
    const [doc] = await rpc(reader, 'SELECT * FROM chat.workspace_create_document_as($1,$2,$3,$4,p_folder=>$5)', [topic, reader, 'plan.md', 'source content', folder.id])
    expect(folder.chat_id).toBe(source); expect(doc.chat_id).toBe(source)
    expect((await rpc(reader, 'SELECT id,chat_id FROM chat.workspace_list_as($1,$2)', [topic, reader])).map((r) => r.id).sort()).toEqual([folder.id, doc.id].sort())
    expect(await rpc(reader, 'SELECT * FROM chat.workspace_status_as($1,$2)', [topic, reader])).toEqual([{ total: 2, documents: 1, files: 0 }])
    expect((await db.query('SELECT chat.is_chat_member($1,$2) AS member', [topic, reader])).rows[0].member).toBe(false)
    expect((await rpc(reader, 'SELECT is_participant FROM chat.list_topics_of_chat($1,$2)', [source, reader]))[0].is_participant).toBe(false)
    expect((await denied(outsider, 'SELECT * FROM chat.workspace_list_as($1,$2)', [topic, outsider])).hint).toBe('workspace_not_member')
    expect((await denied(reader, 'SELECT chat.workspace_require_room_member($1,$2)', [topic, reader])).message).toMatch(/permission denied/)
  })

  it('an agent needs its own source membership; the owner JWT is delegation, not file membership', async () => {
    expect((await rpc(agentOwner, 'SELECT * FROM chat.chat_facts($1,$2)', [topic, agent]))[0].source_chat_id).toBe(source)
    const [doc] = await rpc(agentOwner, 'SELECT * FROM chat.workspace_create_document_as($1,$2,$3,$4)', [topic, agent, 'agent.md', 'owned by actor'])
    expect(doc).toMatchObject({ chat_id: source, created_by: agent })
    expect((await denied(reader, 'SELECT * FROM chat.workspace_get_as($1,$2)', [doc.id, agent])).message).toMatch(/Not allowed to act as/)
    expect((await denied(owner, 'SELECT * FROM chat.workspace_create_document_as($1,$2,$3)', [topic, topicOnlyAgent, 'denied.md'])).hint).toBe('workspace_not_member')
    expect((await db.query('SELECT chat.is_chat_member($1,$2) AS member', [source, topicOnlyAgent])).rows[0].member).toBe(false)
    const grants = await db.query('SELECT * FROM chat.files_authorize($1,$2,$3)', [doc.id, agentOwner, agent])
    expect(grants.rows[0]).toMatchObject({ chat_id: source, actor_id: agent })
    expect((await db.query('SELECT * FROM chat.files_authorize($1,$2,$3)', [doc.id, owner, topicOnlyAgent])).rows).toEqual([])
    expect((await rpc(owner, 'SELECT chat.can_speak_in_topic($1,$2) AS allowed', [topic, topicOnlyAgent]))[0].allowed).toBe(true)
  })

  it('attachment commit/retry and forwarding keep topic messages but one source item and pinned bytes', async () => {
    const { sent, upload, message } = await attached()
    expect(sent.chat_id).toBe(topic)
    const item = (await rpc(reader, 'SELECT * FROM chat.workspace_get_as($1,$2)', [sent.file_item_id, reader]))[0]
    expect(item.chat_id).toBe(source); expect(item.system_role).toBe(null)
    expect((await db.query('SELECT chat_id,system_role FROM chat.workspace_items WHERE id=$1', [item.parent_id])).rows).toEqual([{ chat_id: source, system_role: 'attachments' }])
    expect((await rpc(reader, 'SELECT * FROM chat.file_urls_as($1::jsonb,$2)', [JSON.stringify([{ item_id: item.id, version: sent.file_version }]), reader]))[0]).toMatchObject({ item_id: item.id, chat_id: source, bucket_id: 'oss' })
    expect((await rpc(owner, 'SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5)', [upload.key, message, topic, owner, 'proof.txt']))[0].id).toBe(message)
    const secondTopic = await topicIn(source)
    const [forwarded] = await rpc(owner, 'SELECT * FROM chat.attachment_forward($1,$2,$3,$4)', [message, randomUUID(), secondTopic, owner])
    expect(forwarded).toMatchObject({ chat_id: secondTopic, file_item_id: item.id, file_version: sent.file_version })
    expect((await db.query('SELECT count(*)::int AS n FROM chat.workspace_items WHERE blob_id=$1', [upload.blob])).rows[0].n).toBe(1)
    expect((await db.query('SELECT chat.is_chat_member($1,$2) AS member', [topic, reader])).rows[0].member).toBe(false)
    expect(await rpc(outsider, 'SELECT * FROM chat.file_urls_as($1::jsonb,$2)', [JSON.stringify([{ item_id: item.id }]), outsider])).toEqual([])
    const envelope = (await db.query('SELECT chat.workspace_version_envelope($1,1) AS content', [item.id])).rows[0].content
    const wrong = await denied(owner, `INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,file_item_id,file_version)
      VALUES ($1,$2,$3,$5,'attachment',$4,1)`, [randomUUID(), other, owner, item.id, envelope])
    expect(wrong.hint).toBe('message_file_not_here')
  })

  it('pending file placement addressed to a topic is idempotent and cannot be reused in a different source', async () => {
    const upload = await staged(reader)
    const args = [upload.key, topic, reader, 'file.txt']
    const [first] = await rpc(reader, 'SELECT * FROM chat.file_place_as($1,$2,$3,$4)', args)
    expect(first.chat_id).toBe(source)
    expect((await rpc(reader, 'SELECT * FROM chat.file_place_as($1,$2,$3,$4)', args))[0].id).toBe(first.id)
    expect((await denied(owner, 'SELECT * FROM chat.file_place_as($1,$2,$3,$4)', [upload.key, other, owner, 'bad.txt'])).hint).toBe('attachment_upload_not_found')
    await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'member')`, [other, reader])
    expect((await denied(reader, 'SELECT * FROM chat.file_place_as($1,$2,$3,$4)', [upload.key, other, reader, 'wrong-container.txt'])).hint).toBe('attachment_upload_used')
    expect((await denied(reader, 'INSERT INTO chat.workspace_items(chat_id,kind,filename) VALUES ($1,\'document\',\'bypass\')', [topic])).message).toMatch(/permission denied/)
    await db.query('SAVEPOINT placement')
    await expect(db.query(`INSERT INTO chat.workspace_items(chat_id,kind,filename) VALUES ($1,'document','bad')`, [topic])).rejects.toMatchObject({ hint: 'workspace_topic_container' })
    await db.query('ROLLBACK TO SAVEPOINT placement')
  })

  it('legacy Storage keys keep their bytes address but use source membership for read/write/delete', async () => {
    const pointer = `${topic}/${owner}/${randomUUID()}.txt`
    await db.query(`INSERT INTO storage.objects(bucket_id,name) VALUES ('workspace',$1)`, [pointer])
    const [file] = await rpc(owner, 'SELECT * FROM chat.workspace_create_file_as($1,$2,$3,$4,$5,$6)', [topic, owner, 'old.txt', 'text/plain', 3, pointer])
    expect(file).toMatchObject({ chat_id: source, pointer })
    expect(await rpc(reader, `SELECT name FROM storage.objects WHERE bucket_id='workspace' AND name=$1`, [pointer])).toEqual([{ name: pointer }])
    expect(await rpc(outsider, `SELECT name FROM storage.objects WHERE bucket_id='workspace' AND name=$1`, [pointer])).toEqual([])
    const fresh = `${topic}/${reader}/${randomUUID()}.txt`
    expect((await rpc(reader, `INSERT INTO storage.objects(bucket_id,name) VALUES ('workspace',$1) RETURNING name`, [fresh]))[0].name).toBe(fresh)
    expect((await rpc(reader, `DELETE FROM storage.objects WHERE bucket_id='workspace' AND name=$1 RETURNING name`, [fresh]))[0].name).toBe(fresh)
    expect(await rpc(owner, `DELETE FROM storage.objects WHERE bucket_id='workspace' AND name=$1 RETURNING name`, [pointer])).toEqual([])
    expect((await denied(outsider, `INSERT INTO storage.objects(bucket_id,name) VALUES ('workspace',$1)`, [`${topic}/${outsider}/denied.txt`])).message).toMatch(/row-level security/)
  })

  it('shared files do not expose hidden topic history or whisper bytes', async () => {
    const old = randomUUID()
    await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,created_at) VALUES ($1,$2,$3,'hidden',now()-interval '1 hour')`, [old, topic, owner])
    await db.query('UPDATE chat.chats SET hide_history=true WHERE id=$1', [source])
    await db.query('UPDATE chat.chat_members SET hide_history_before=now() WHERE chat_id=$1 AND user_id=$2', [source, reader])
    const [doc] = await rpc(owner, 'SELECT * FROM chat.workspace_create_document_as($1,$2,$3)', [topic, owner, 'shared.md'])
    expect((await rpc(reader, 'SELECT id FROM chat.workspace_get_as($1,$2)', [doc.id, reader]))[0].id).toBe(doc.id)
    expect(await rpc(reader, 'SELECT id FROM chat.messages WHERE id=$1', [old])).toEqual([])
    // A whisper still requires an actual topic participant as its recipient.
    await rpc(reader, `INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'join')`, [randomUUID(), topic, reader])
    expect(await rpc(reader, 'SELECT id FROM chat.messages WHERE id=$1', [old])).toEqual([])
    const { sent, message } = await attached(topic, true)
    expect(sent.file_item_id).toBe(null); expect(sent.file_blob_id).toBeTruthy()
    expect((await rpc(reader, 'SELECT * FROM chat.file_urls_as($1::jsonb,$2)', [JSON.stringify([{ message_id: message }]), reader]))[0].message_id).toBe(message)
    expect(await rpc(agentOwner, 'SELECT * FROM chat.file_urls_as($1::jsonb,$2)', [JSON.stringify([{ message_id: message }]), agent])).toEqual([])
    expect((await db.query('SELECT count(*)::int AS n FROM chat.workspace_items WHERE blob_id=$1', [sent.file_blob_id])).rows[0].n).toBe(0)
  })

  it('leaving the source revokes metadata, signatures and file-service authorization', async () => {
    const { sent } = await attached()
    const [doc] = await rpc(reader, 'SELECT * FROM chat.workspace_create_document_as($1,$2,$3)', [topic, reader, 'mine.md'])
    expect((await db.query('SELECT * FROM chat.files_authorize($1,$2)', [doc.id, reader])).rows).toHaveLength(1)
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [source, reader])
    expect((await denied(reader, 'SELECT * FROM chat.workspace_get_as($1,$2)', [doc.id, reader])).hint).toBe('workspace_item_not_found')
    expect(await rpc(reader, 'SELECT * FROM chat.file_urls_as($1::jsonb,$2)', [JSON.stringify([{ item_id: sent.file_item_id }]), reader])).toEqual([])
    expect((await db.query('SELECT * FROM chat.files_authorize($1,$2)', [doc.id, reader])).rows).toEqual([])
    expect((await rpc(owner, 'SELECT id FROM chat.workspace_get_as($1,$2)', [doc.id, owner]))[0].id).toBe(doc.id)
  })

  it('a direct-chat topic has the same container rule without depending on groupId', async () => {
    const dm = await room('dm', [reader]), dmTopic = await topicIn(dm)
    const number = String((await db.query('SELECT public_id FROM chat.chats WHERE id=$1', [dmTopic])).rows[0].public_id)
    expect(await rpc(reader, 'SELECT * FROM chat.chat_facts($1,$2)', [number, reader]))
      .toEqual(await rpc(reader, 'SELECT * FROM chat.chat_facts($1,$2)', [dmTopic, reader]))
    const [doc] = await rpc(reader, 'SELECT * FROM chat.workspace_create_document_as($1,$2,$3)', [dmTopic, reader, 'dm.md'])
    expect(doc.chat_id).toBe(dm)
    expect((await rpc(reader, 'SELECT id FROM chat.workspace_list_as($1,$2)', [dmTopic, reader]))[0].id).toBe(doc.id)
  })
})
