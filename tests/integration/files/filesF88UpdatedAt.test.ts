import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Text } from 'yjs'

import { Fixture, SUBPROTOCOL, editFile, filesConfig, machine, openPage, sleep, startFiles, startIssuer, waitFor, type Issuer, type Running } from './support.ts'

/**
 * 摩擦单 F88(S24):A 只是打开 `笔记.md`、一个字没改,列表却对所有人显示「刚刚改过」。规则只有一条:正文真的变了,
 * updated_at 才动。对照(今天的库,没有 20260929223000):第一次打开把 ystate 钉进库、冷压缩换代、改名,都会把
 * updated_at 刷成 now()。
 */
let fx: Fixture
let issuer: Issuer
let dbUrl: string
let chat: string
const u = { a: '', b: '', agent: '' }

beforeAll(async () => {
  fx = new Fixture()
  await fx.connect()
  issuer = await startIssuer()
  dbUrl = await fx.filesLogin()
  u.a = await fx.person('F88 A')
  u.b = await fx.person('F88 B')
  u.agent = await fx.agentOf(u.b, 'Content editor agent')
  chat = await fx.group(u.b, [u.a, u.agent])
})
afterAll(async () => {
  await issuer?.close()
  await fx?.cleanup()
})

/** 一个一小时前由 B 建的文件,只有正文、还没有 ystate —— agent 或 HTTP 建的文件都是这样。 */
async function fileFromAnHourAgo(filename: string, text: string, kind: 'document' | 'file' = 'document'): Promise<string> {
  const { rows } = await fx.admin.query<{ id: string }>(
    `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, inline_text, blob_id, size_bytes, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::text IS NULL THEN NULL ELSE chat.file_blob_for_pointer($6, $7, $4, $8) END, $7, $8, now() - interval '1 hour', now() - interval '1 hour') RETURNING id`,
    [
      chat,
      kind,
      filename,
      kind === 'document' ? 'text/markdown' : 'image/png',
      kind === 'document' ? text : null,
      kind === 'file' ? `${chat}/${filename}` : null,
      Buffer.byteLength(text),
      u.b,
    ],
  )
  return rows[0]!.id
}

async function row(itemId: string) {
  const { rows } = await fx.admin.query<{ updated_at: Date; updated_by: string | null; inline_text: string | null; ys: number | null; epoch: number }>(
    'SELECT updated_at, updated_by, inline_text, length(ystate) AS ys, epoch FROM chat.workspace_items WHERE id = $1',
    [itemId],
  )
  return rows[0]!
}

describe('F88 只有正文变了才算改过', () => {
  let svc: Running
  afterAll(async () => svc?.close())

  /** A 打开这个文件,`write` 之后关掉,等到服务把它卸载(存盘在卸载之前)。 */
  async function openAndClose(itemId: string, epoch: number, write?: (text: Text) => void, actor = u.a) {
    const m = machine(svc.url, await issuer.mint(actor))
    const page = openPage(m, itemId, epoch)
    await page.synced
    if (write) write(page.doc.getText('content'))
    await sleep(300)
    page.close()
    expect(await waitFor(() => !svc.service.hocuspocus.documents.has(`${itemId}@${epoch}`), 5000)).toBeGreaterThanOrEqual(0)
    m.socket.destroy()
  }

  it('打开、不改、关掉:updated_at 不变 —— 第一次打开把 ystate 钉进库,第二次照常存盘,都一样', async () => {
    svc = await startFiles(filesConfig(dbUrl, issuer.jwksUrl, { debounceMs: 100, maxDebounceMs: 300 }))
    const doc = await fileFromAnHourAgo('笔记.md', '三个字')
    const before = await row(doc)
    expect(before.ys).toBeNull()
    expect(before.updated_by).toBeNull()
    expect(Buffer.byteLength(before.inline_text!)).toBe(9)

    await openAndClose(doc, 0)
    const pinned = await row(doc)
    expect(pinned.ys).toBeGreaterThan(0) // 这一行被 UPDATE 过(ystate 钉进库)……
    expect(pinned.inline_text).toBe('三个字')
    expect(pinned.updated_by).toBeNull()
    expect(pinned.updated_at.getTime()).toBe(before.updated_at.getTime()) // ……但没人改正文

    await openAndClose(doc, 0)
    expect((await row(doc)).updated_at.getTime()).toBe(before.updated_at.getTime())
  })

  it('改一个字:updated_at 变', async () => {
    const doc = await fileFromAnHourAgo('改一个字.md', '三个字')
    const before = await row(doc)
    await openAndClose(doc, 0, (text) => text.insert(text.length, '!'))
    const after = await row(doc)
    expect(after.inline_text).toBe('三个字!')
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime())
    expect(after.updated_by).toBe(u.a)
  })

  it('opening after another person edited preserves that editor; a real edit changes it', async () => {
    const doc = await fileFromAnHourAgo('human-editor.md', '三个字')
    await openAndClose(doc, 0, (text) => text.insert(text.length, ' A'))
    const edited = await row(doc)
    expect(edited.updated_by).toBe(u.a)
    await openAndClose(doc, 0, undefined, u.b)
    expect((await row(doc)).updated_by).toBe(u.a)
    expect((await row(doc)).updated_at).toEqual(edited.updated_at)
    await openAndClose(doc, 0, (text) => text.insert(text.length, ' B'), u.b)
    expect(await row(doc)).toMatchObject({ inline_text: '三个字 A B', updated_by: u.b })
  })

  it.each([false, true])('pending store keeps the actual content writer when the next transaction changes content=%s', async (contentChanged) => {
    const doc = await fileFromAnHourAgo(`pending-editor-${contentChanged}.md`, '三个字')
    const a = machine(svc.url, await issuer.mint(u.a))
    const b = machine(svc.url, await issuer.mint(u.b))
    const pa = openPage(a, doc, 0), pb = openPage(b, doc, 0)
    try {
      await Promise.all([pa.synced, pb.synced])
      const live = svc.service.hocuspocus.documents.get(`${doc}@0`)!
      // Hold the actual persistence mutex, then flush A's pending callback into its queue.
      // B changes the live document before that callback can take its content snapshot.
      const release = await live.saveMutex.acquire()
      let pending: Promise<unknown> | undefined
      try {
        pa.doc.getText('content').insert(0, 'A ')
        expect(await waitFor(() => pb.text() === 'A 三个字')).toBeGreaterThanOrEqual(0)
        const key = `onStoreDocument-${doc}@0`
        expect(await waitFor(() => svc.service.hocuspocus.debouncer.isDebounced(key) || svc.service.hocuspocus.debouncer.isCurrentlyExecuting(key))).toBeGreaterThanOrEqual(0)
        pending = svc.service.hocuspocus.debouncer.executeNow(key)
        expect(await waitFor(() => svc.service.hocuspocus.debouncer.isCurrentlyExecuting(key))).toBeGreaterThanOrEqual(0)
        if (contentChanged) pb.doc.getText('content').insert(0, 'B ')
        else pb.doc.getText('content').format(0, 1, { bold: true })
        // Waiting for the server's transaction (including formatting) makes the order explicit.
        expect(await waitFor(() => contentChanged ? pa.text() === 'B A 三个字' : pa.doc.getText('content').toDelta().some((d) => d.attributes?.bold))).toBeGreaterThanOrEqual(0)
        expect((await row(doc)).inline_text).toBe('三个字')
      } finally { release() }
      await pending
      expect(await waitFor(async () => (await row(doc)).inline_text === (contentChanged ? 'B A 三个字' : 'A 三个字'))).toBeGreaterThanOrEqual(0)
      expect((await row(doc)).updated_by).toBe(contentChanged ? u.b : u.a)
    } finally {
      pa.close(); pb.close()
      a.socket.destroy(); b.socket.destroy()
    }
  })

  it('WebSocket and HTTP delegated edits record the agent, and metadata RPCs return the same author', async () => {
    const doc = await fileFromAnHourAgo('actor-metadata.md', '三个字')
    const owner = await issuer.mint(u.b)
    const m = machine(svc.url, owner, { protocols: [SUBPROTOCOL, `bearer.${owner}`, `as.${u.agent}`] })
    const page = openPage(m, doc, 0)
    let closed = false
    try {
      await page.synced
      page.doc.getText('content').insert(3, '!')
      page.close(); closed = true
      expect(await waitFor(() => !svc.service.hocuspocus.documents.has(`${doc}@0`))).toBeGreaterThanOrEqual(0)
      expect((await row(doc)).updated_by).toBe(u.agent)
    } finally { if (!closed) page.close(); m.socket.destroy() }
    expect((await editFile(svc.url, await issuer.mint(u.a), doc, '三个字!', 'human edit')).status).toBe(200)
    expect((await row(doc)).updated_by).toBe(u.a)
    expect((await editFile(svc.url, owner, doc, 'human edit', 'agent edit', u.agent)).status).toBe(200)
    expect(await row(doc)).toMatchObject({ inline_text: 'agent edit', updated_by: u.agent })

    await fx.admin.query('BEGIN')
    try {
      await fx.admin.query('SET LOCAL role TO authenticated')
      await fx.admin.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: u.b, role: 'authenticated' })])
      await fx.admin.query('SELECT chat.workspace_note_open($1)', [doc])
      const reads: [string, unknown[]][] = [
        ['SELECT created_by,updated_by FROM chat.workspace_get_as($1,$2)', [doc, u.b]],
        ['SELECT created_by,updated_by FROM chat.workspace_list_as($1,$2,p_name=>$3,p_exact=>true)', [chat, u.b, 'actor-metadata.md']],
        ['SELECT created_by,updated_by FROM chat.workspace_search($1,NULL,50,$2) WHERE id=$3', ['actor-metadata.md', u.b, doc]],
        ['SELECT created_by,updated_by FROM chat.workspace_recent(50,$1) WHERE id=$2', [u.b, doc]],
      ]
      for (const [sql, values] of reads) expect((await fx.admin.query(sql, values)).rows).toEqual([{ created_by: u.b, updated_by: u.agent }])
    } finally { await fx.admin.query('ROLLBACK') }
  })

  it('recreated metadata RPCs stay closed to anonymous callers and the author column stays service-written', async () => {
    for (const signature of [
      'chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean)', 'chat.workspace_get_as(text,text)',
      'chat.workspace_search(text,text[],integer,text)', 'chat.workspace_recent(integer,text)',
      'chat.workspace_replace_file_as(text,text,text,bigint,text,integer)', 'chat.file_replace_as(text,text,text,integer)',
    ]) {
      const { rows } = await fx.admin.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS allowed, has_function_privilege('anon',$1,'EXECUTE') AS anonymous", [signature])
      expect(rows).toEqual([{ allowed: true, anonymous: false }])
    }
    const { rows } = await fx.admin.query("SELECT has_column_privilege('gugu_files','chat.workspace_items','updated_by','UPDATE') AS writer, has_column_privilege('authenticated','chat.workspace_items','updated_by','UPDATE') AS reader")
    expect(rows).toEqual([{ writer: true, reader: false }])
  })

  it('写了又删回去(ystate 变、正文没变),卸载时冷压缩换代:都不算改过', async () => {
    await svc.close()
    // 压缩门槛压到 0:一卸载就压。
    svc = await startFiles(filesConfig(dbUrl, issuer.jwksUrl, { debounceMs: 100, maxDebounceMs: 300, compactRatio: 0, compactMinBytes: 0 }))
    const doc = await fileFromAnHourAgo('写了又删.md', '三个字')
    const hourAgo = (await row(doc)).updated_at.getTime()
    await openAndClose(doc, 0) // 钉进库;卸载时就压了一次
    expect(await waitFor(() => svc.service.stats.compactions > 0, 5000)).toBeGreaterThanOrEqual(0)
    const before = await row(doc)
    expect(before.epoch).toBe(1)
    expect(before.updated_at.getTime()).toBe(hourAgo)
    const compactions = svc.service.stats.compactions
    await openAndClose(doc, before.epoch, (text) => {
      text.insert(1, 'xyz')
      text.delete(1, 3)
    })
    expect(await waitFor(() => svc.service.stats.compactions > compactions, 5000)).toBeGreaterThanOrEqual(0)
    const after = await row(doc)
    expect(after.epoch).toBe(before.epoch + 1) // 换了一代
    expect(after.inline_text).toBe('三个字')
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime())
    expect(after.updated_by).toBe(before.updated_by)
  })

  it('库里的规则本身:改名、来源消息、清 created_by、显式写 updated_at 都不动它;正文、文件的字节(blob)动它', async () => {
    // 一个事务里做完再回滚:存储对象(文件的 blob 要指向真的对象)不留在库里。
    await fx.admin.query('BEGIN')
    try {
      await fx.admin.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('workspace', $1), ('workspace', $1 || '.v2')`, [`${chat}/图.png`])
      const doc = await fileFromAnHourAgo('规则.md', '正文')
      const file = await fileFromAnHourAgo('图.png', 'png-bytes', 'file')
      const at = async (id: string) => (await row(id)).updated_at.getTime()
      const hourAgo = await at(doc)
      await fx.admin.query(`UPDATE chat.workspace_items SET filename = '规则 2.md' WHERE id = $1`, [doc])
      await fx.admin.query(`UPDATE chat.workspace_items SET source_message_ids = ARRAY['m1'] WHERE id = $1`, [doc])
      await fx.admin.query(`UPDATE chat.workspace_items SET created_by = NULL WHERE id = $1`, [doc])
      await fx.admin.query(`UPDATE chat.workspace_items SET filename = '规则 3.md', updated_at = now() WHERE id = $1`, [doc])
      expect(await at(doc)).toBe(hourAgo)
      await fx.admin.query(`UPDATE chat.workspace_items SET inline_text = '正文改了', updated_by = $2 WHERE id = $1`, [doc, u.a])
      expect((await row(doc)).updated_by).toBe(u.a)
      const editedAt = await at(doc)
      await fx.admin.query(`UPDATE chat.workspace_items SET filename = 'same-content.md', updated_by = $2 WHERE id = $1`, [doc, u.b])
      expect((await row(doc)).updated_by).toBe(u.a)
      expect(await at(doc)).toBe(editedAt)
      expect(await at(doc)).toBeGreaterThan(hourAgo)

      const fileHourAgo = await at(file)
      await fx.admin.query(`UPDATE chat.workspace_items SET filename = '图 2.png' WHERE id = $1`, [file])
      expect(await at(file)).toBe(fileHourAgo)
      // 只升版本、字节没变(改名、移动就是这样)⇒ 不动它。
      await fx.admin.query(`UPDATE chat.workspace_items SET version = version + 1 WHERE id = $1`, [file])
      expect(await at(file)).toBe(fileHourAgo)
      // 文件的字节只随新版本变(20261017012120 的守卫,与 workspace_replace_file_as 同):换 blob 同时升版本。
      await fx.admin.query(`UPDATE chat.workspace_items SET blob_id = chat.file_blob_for_pointer(chat.file_blob_pointer(blob_id) || '.v2', size_bytes, content_type, created_by), version = version + 1, updated_by = $2 WHERE id = $1`, [file, u.b])
      expect((await row(file)).updated_by).toBe(u.b)
      expect(await at(file)).toBeGreaterThan(fileHourAgo)
    } finally {
      await fx.admin.query('ROLLBACK')
    }
  })
})
