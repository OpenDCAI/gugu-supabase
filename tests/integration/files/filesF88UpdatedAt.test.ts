import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Text } from 'yjs'

import { Fixture, filesConfig, machine, openPage, sleep, startFiles, startIssuer, waitFor, type Issuer, type Running } from './support.ts'

/**
 * 摩擦单 F88(S24):A 只是打开 `笔记.md`、一个字没改,列表却对所有人显示「刚刚改过」。规则只有一条:正文真的变了,
 * updated_at 才动。对照(今天的库,没有 20260929223000):第一次打开把 ystate 钉进库、冷压缩换代、改名,都会把
 * updated_at 刷成 now()。
 */
let fx: Fixture
let issuer: Issuer
let dbUrl: string
let chat: string
const u = { a: '', b: '' }

beforeAll(async () => {
  fx = new Fixture()
  await fx.connect()
  issuer = await startIssuer()
  dbUrl = await fx.filesLogin()
  u.a = await fx.person('F88 A')
  u.b = await fx.person('F88 B')
  chat = await fx.group(u.b, [u.a])
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
  const { rows } = await fx.admin.query<{ updated_at: Date; inline_text: string | null; ys: number | null; epoch: number }>(
    'SELECT updated_at, inline_text, length(ystate) AS ys, epoch FROM chat.workspace_items WHERE id = $1',
    [itemId],
  )
  return rows[0]!
}

describe('F88 只有正文变了才算改过', () => {
  let svc: Running
  afterAll(async () => svc?.close())

  /** A 打开这个文件,`write` 之后关掉,等到服务把它卸载(存盘在卸载之前)。 */
  async function openAndClose(itemId: string, epoch: number, write?: (text: Text) => void) {
    const m = machine(svc.url, await issuer.mint(u.a))
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
    expect(Buffer.byteLength(before.inline_text!)).toBe(9)

    await openAndClose(doc, 0)
    const pinned = await row(doc)
    expect(pinned.ys).toBeGreaterThan(0) // 这一行被 UPDATE 过(ystate 钉进库)……
    expect(pinned.inline_text).toBe('三个字')
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
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime() + 30 * 60_000)
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
      await fx.admin.query(`UPDATE chat.workspace_items SET inline_text = '正文改了' WHERE id = $1`, [doc])
      expect(await at(doc)).toBeGreaterThan(hourAgo + 30 * 60_000)

      const fileHourAgo = await at(file)
      await fx.admin.query(`UPDATE chat.workspace_items SET filename = '图 2.png' WHERE id = $1`, [file])
      expect(await at(file)).toBe(fileHourAgo)
      // 只升版本、字节没变(改名、移动就是这样)⇒ 不动它。
      await fx.admin.query(`UPDATE chat.workspace_items SET version = version + 1 WHERE id = $1`, [file])
      expect(await at(file)).toBe(fileHourAgo)
      // 文件的字节只随新版本变(20261017012120 的守卫,与 workspace_replace_file_as 同):换 blob 同时升版本。
      await fx.admin.query(`UPDATE chat.workspace_items SET blob_id = chat.file_blob_for_pointer(chat.file_blob_pointer(blob_id) || '.v2', size_bytes, content_type, created_by), version = version + 1 WHERE id = $1`, [file])
      expect(await at(file)).toBeGreaterThan(fileHourAgo + 30 * 60_000)
    } finally {
      await fx.admin.query('ROLLBACK')
    }
  })
})
