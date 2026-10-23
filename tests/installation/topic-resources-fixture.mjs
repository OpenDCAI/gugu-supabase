import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'

// Used only before the topic-resource release on the disposable installation DB.
export async function topicResourcesFixture(db) {
  const owner = randomUUID(), reader = randomUUID()
  const group = randomUUID(), dm = randomUUID()
  const topics = Array.from({ length: 6 }, randomUUID)
  const blob = randomUUID(), oldBlob = randomUUID(), file = randomUUID()
  const staging = `staging/${owner}/${randomUUID()}`
  const pointer = `${topics[0]}/${owner}/old.txt`
  const legacy = `${owner}/legacy.txt`, missing = `${owner}/missing.txt`
  const boards = [], systems = []
  const sha = randomUUID().replaceAll('-', '').repeat(2)
  await db.query('BEGIN')
  try {
    await db.query(`INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human','owner'),($2,'human','reader')`, [owner, reader])
    for (const [chat, kind] of [[group, 'group'], [dm, 'dm']]) {
      await db.query('INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,$2,$3,$4)', [chat, kind, kind === 'group' ? 'upgrade fixture' : null, owner])
      await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')`, [chat, owner, reader])
      const message = randomUUID()
      await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'source')`, [message, chat, owner])
      for (const topic of topics.slice(chat === group ? 0 : 4, chat === group ? 4 : 6)) {
        await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id,source_message_id)
          VALUES ($1,'topic','upgrade topic',$2,$3,$4)`, [topic, owner, chat, message])
        await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role,last_read_seq) VALUES ($1,$2,'owner',7)`, [topic, owner])
        const { rows } = await db.query(`SELECT chat.workspace_system_folder($1,'attachments') AS id`, [topic])
        systems.push(rows[0].id)
      }
    }
    const rootSystem = (await db.query(`SELECT chat.workspace_system_folder($1,'attachments') AS id`, [group])).rows[0].id
    async function document(chat, name, text, parent = null, state = null) {
      const id = randomUUID()
      await db.query(`INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,inline_text,size_bytes,created_by,parent_id,ystate)
        VALUES ($1,$2,'document',$3,'application/json',$4,$5,$6,$7,$8)`, [id, chat, name, text, Buffer.byteLength(text), owner, parent, state])
      return id
    }
    for (const [i, chat] of [group, ...topics.slice(0, 4)].entries()) {
      const content = JSON.stringify({ origin: i })
      const y = new Y.Doc(); y.getMap('data').set('origin', i)
      boards.push(await document(chat, 'Board.board.json', content, null, Buffer.from(Y.encodeStateAsUpdate(y))))
      y.destroy()
    }
    await db.query(`INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,created_by)
      VALUES ($1,$2,'folder','Notes','inode/directory',$3),($4,$5,'folder','Notes','inode/directory',$3)`,
      [randomUUID(), group, owner, randomUUID(), topics[0]])
    const userFolder = (await db.query(`SELECT id FROM chat.workspace_items WHERE chat_id=$1 AND filename='Notes'`, [topics[0]])).rows[0].id
    const child = await document(topics[0], 'keep.json', '{"nested":true}', userFolder)
    await db.query(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES
      ('workspace',$1,'{"size":3,"mimetype":"text/plain"}'),('chat-media',$2,'{"size":3,"mimetype":"text/plain"}')`, [pointer, legacy])
    await db.query(`INSERT INTO chat.file_blobs(id,bucket_id,object_name,sha256,size_bytes,content_type) VALUES
      ($1,'oss',$2,$3,3,'text/plain'),($4,'workspace',$5,NULL,3,'text/plain')`, [blob, sha.slice(0, 2) + '/' + sha, sha, oldBlob, pointer])
    await db.query(`INSERT INTO chat.workspace_items(id,chat_id,parent_id,kind,filename,content_type,blob_id,size_bytes,created_by,version)
      VALUES ($1,$2,$3,'file','same.txt','text/plain',$4,3,$5,3),($6,$7,$8,'file','same.txt','text/plain',$4,3,$5,1)`,
      [file, topics[0], systems[0], blob, owner, randomUUID(), group, rootSystem])
    await db.query(`INSERT INTO chat.workspace_item_versions(item_id,n,blob_id,content_type,size_bytes,made_by)
      VALUES ($1,1,$2,'text/plain',3,$3)`, [file, oldBlob, owner])
    await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,file_item_id,file_version)
      VALUES ($1,$2,$3,chat.workspace_version_envelope($4,1),'attachment',$4,1)`, [randomUUID(), topics[0], owner, file])
    for (const key of [legacy, missing]) {
      await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,storage_bucket_id,storage_object_name)
        VALUES ($1,$2,$3,'[附件] legacy.txt (text/plain)','attachment','chat-media',$4)`, [randomUUID(), topics[0], owner, key])
    }
    await db.query(`INSERT INTO chat.file_blob_uploads(staging_key,uploader,blob_id,item_id,item_version)
      VALUES ($1,$2,$3,$4,3)`, [staging, owner, blob, file])
    await db.query('COMMIT')
    const chats = [group, dm, ...topics]
    const rows = (sql, args = []) => db.query(sql, args).then((r) => r.rows)
    const snapshot = async () => ({
      items: await rows(`SELECT to_jsonb(w) AS item FROM chat.workspace_items w WHERE chat_id=ANY($1) ORDER BY id`, [chats]),
      versions: await rows(`SELECT * FROM chat.workspace_item_versions WHERE item_id=$1 ORDER BY n`, [file]),
      blobs: await rows(`SELECT * FROM chat.file_blobs WHERE id=ANY($1::uuid[]) ORDER BY id`, [[blob, oldBlob]]),
      messages: await rows(`SELECT * FROM chat.messages WHERE chat_id=ANY($1) ORDER BY id`, [chats]),
      members: await rows(`SELECT * FROM chat.chat_members WHERE chat_id=ANY($1) ORDER BY chat_id,user_id`, [chats]),
      uploads: await rows(`SELECT * FROM chat.file_blob_uploads WHERE staging_key=$1`, [staging]),
      storage: await rows(`SELECT * FROM storage.objects WHERE name=ANY($1) ORDER BY name`, [[pointer, legacy]]),
    })
    const before = await snapshot()
    return {
      snapshot,
      before,
      async assertMigrated() {
        const after = await snapshot()
        for (const key of ['versions', 'blobs', 'messages', 'members', 'uploads', 'storage']) assert.deepEqual(after[key], before[key], key + ' is unchanged')
        assert.equal((await rows(`SELECT count(*)::int AS n FROM chat.workspace_items WHERE chat_id=ANY($1)`, [topics]))[0].n, 0)
        const boardRows = await rows(`SELECT id,chat_id,filename,inline_text,ystate FROM chat.workspace_items WHERE id=ANY($1::uuid[])`, [boards])
        assert.equal(boardRows.length, 5)
        assert.equal(new Set(boardRows.map((b) => b.filename)).size, 5)
        assert.equal(boardRows.find((b) => b.id === boards[0]).filename, 'Board.board.json')
        assert.ok(boardRows.every((b) => b.chat_id === group && b.ystate.length > 0))
        const moved = (await rows(`SELECT * FROM chat.workspace_items WHERE id=$1`, [file]))[0]
        assert.equal(moved.chat_id, group); assert.equal(moved.parent_id, rootSystem)
        assert.equal(moved.version, 3); assert.equal(moved.blob_id, blob)
        assert.notEqual(moved.filename, 'same.txt')
        assert.equal((await rows(`SELECT parent_id FROM chat.workspace_items WHERE id=$1`, [child]))[0].parent_id, userFolder)
        assert.equal((await rows(`SELECT filename FROM chat.workspace_items WHERE id=$1`, [userFolder]))[0].filename, 'Notes (2)')
        const adopted = await rows(`SELECT id FROM chat.workspace_items WHERE chat_id=$1 AND system_role='attachments'`, [dm])
        assert.equal(adopted.length, 1); assert.ok(systems.slice(4).includes(adopted[0].id))
        await db.query('BEGIN')
        try {
          await db.query('SET LOCAL ROLE authenticated')
          await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [owner])
          const retry = await rows('SELECT id,chat_id FROM chat.file_place_as($1,$2,$3,$4)', [staging, topics[0], owner, 'ignored.txt'])
          assert.deepEqual(retry, [{ id: file, chat_id: group }])
        } finally { await db.query('ROLLBACK') }
      },
      async poison() {
        await db.query(`INSERT INTO chat.workspace_item_versions(item_id,n,inline_text,content_type,size_bytes,made_by)
          VALUES ($1,1,'must not disappear','text/plain',18,$2)`, [systems[0], owner])
      },
      async unpoison() { await db.query('DELETE FROM chat.workspace_item_versions WHERE item_id=$1', [systems[0]]) },
      async cleanup() {
        await db.query('BEGIN')
        try {
          await db.query('DELETE FROM chat.chats WHERE id=ANY($1)', [[group, dm]])
          await db.query('DELETE FROM chat.file_blob_uploads WHERE staging_key=$1', [staging])
          await db.query('DELETE FROM chat.file_blobs WHERE id=ANY($1::uuid[])', [[blob, oldBlob]])
          await db.query('DELETE FROM storage.objects WHERE name=ANY($1)', [[pointer, legacy]])
          await db.query('DELETE FROM identity.users WHERE id=ANY($1)', [[owner, reader]])
          await db.query('COMMIT')
        } catch (error) { await db.query('ROLLBACK'); throw error }
      },
    }
  } catch (error) { await db.query('ROLLBACK'); throw error }
}
