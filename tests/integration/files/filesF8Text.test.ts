import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildDoc } from '../../../packages/files-core/src/content.mjs'
import {
  Fixture,
  editFile,
  getFile,
  machine,
  openPage,
  filesConfig,
  sleep,
  startIssuer,
  startFiles,
  waitFor,
  type Issuer,
  type Running,
} from './support.ts'

/**
 * F8(真源 §2.4「JSON 里的协同文本」):App 用 gugu.text() 建的字段是嵌在 JSON 里的 Y.Text。
 *   · 两个人在同一个文本框里逐字打字、agent 同时按文本改这一段 ⇒ 三方的改动都在,字段仍是协同文本;库里 inline_text 是普通 JSON;
 *   · 冷压缩换代之后字段仍是协同文本(服务配成每次卸载都压缩)。对照:按 inline_text 解析重建,字段会是普通字符串。
 */
let fx: Fixture
let issuer: Issuer
let svc: Running
const u = { a: '', b: '' }
let chat: string

const SEED = JSON.stringify({ title: '周会', slides: [{ title: '一', body: '' }, { title: '二', body: '' }] })
const slidesOf = (doc: Y.Doc) => doc.getMap('root').get('slides') as Y.Array<Y.Map<unknown>>
const bodyOf = (doc: Y.Doc, i: number) => slidesOf(doc).get(i)?.get('body')

beforeAll(async () => {
  fx = new Fixture()
  await fx.connect()
  issuer = await startIssuer()
  svc = await startFiles(filesConfig(await fx.filesLogin(), issuer.jwksUrl, { compactRatio: 0, compactMinBytes: 0 }))
  u.a = await fx.person('F8 A')
  u.b = await fx.person('F8 B')
  chat = await fx.group(u.a, [u.b])
})
afterAll(async () => {
  await svc?.close()
  await issuer?.close()
  await fx?.cleanup()
})

describe('F8 JSON 里的协同文本', () => {
  it('两人逐字打字 + agent 按文本改同一段 ⇒ 三方都在,字段仍是协同文本;冷压缩换代后类型不丢', async () => {
    const file = await fx.file(chat, u.a, 'deck.slides.json', 'application/json', SEED)
    const ta = await issuer.mint(u.a)
    const tb = await issuer.mint(u.b)
    const A = machine(svc.url, ta)
    const B = machine(svc.url, tb)
    const pa = openPage(A, file, 0)
    const pb = openPage(B, file, 0)
    await Promise.all([pa.synced, pb.synced])

    // A 用 gugu.text() 建协同文本字段(运行时做的就是这一步)
    slidesOf(pa.doc).get(0).set('body', new Y.Text('hello world'))
    expect(await waitFor(() => bodyOf(pb.doc, 0) instanceof Y.Text, 3000)).toBeGreaterThanOrEqual(0)

    // 同时:A 在句首、B 在句末逐字打;agent 把 hello 改成 hi
    const ya = bodyOf(pa.doc, 0) as Y.Text
    const yb = bodyOf(pb.doc, 0) as Y.Text
    const typing = (async () => {
      for (const ch of 'AB') {
        ya.insert(0, `[${ch}]`)
        yb.insert(yb.length, `<${ch}>`)
        await sleep(60)
      }
    })()
    await sleep(30)
    // agent 看到的是普通 JSON 字符串;它按文本改(old 在全文里唯一,两人的打字不在它里面)
    expect(((await getFile(svc.url, ta, file)).body.text as string)).toMatch(/"body": "[^"]*hello world/)
    const edited = await editFile(svc.url, ta, file, 'hello', 'hi')
    expect(edited.status).toBe(200)
    await typing
    expect(await waitFor(() => (bodyOf(pa.doc, 0) as Y.Text).toString() === (bodyOf(pb.doc, 0) as Y.Text).toString(), 3000)).toBeGreaterThanOrEqual(0)
    const merged = (bodyOf(pa.doc, 0) as Y.Text).toString()
    expect(merged).toContain('hi world')
    expect(merged).not.toContain('hello')
    for (const t of ['[A]', '[B]', '<A>', '<B>']) expect(merged.split(t).length - 1, t).toBe(1)
    expect(bodyOf(pa.doc, 0)).toBeInstanceOf(Y.Text)
    expect(bodyOf(pb.doc, 0)).toBeInstanceOf(Y.Text)

    // 关掉 ⇒ 存盘、卸载、(配置成每次都)冷压缩换代
    pa.close()
    pb.close()
    expect(await waitFor(() => svc.service.stats.compactions > 0, 10_000, 50)).toBeGreaterThanOrEqual(0)
    const row = await fx.row(file)
    expect(row!.epoch).toBe(1)
    expect(JSON.parse(row!.inline_text!).slides[0].body).toBe(merged) // inline_text 是普通 JSON 字符串

    const pc = openPage(A, file, 1)
    await pc.synced
    expect(bodyOf(pc.doc, 0)).toBeInstanceOf(Y.Text)
    expect((bodyOf(pc.doc, 0) as Y.Text).toString()).toBe(merged)
    // 压缩后照样能逐字协同
    const pd = openPage(B, file, 1)
    await pd.synced
    ;(bodyOf(pc.doc, 0) as Y.Text).insert(0, '✓')
    expect(await waitFor(() => String(bodyOf(pd.doc, 0)).startsWith('✓'), 3000)).toBeGreaterThanOrEqual(0)

    // 对照:按 inline_text 解析重建(F8 之前的压缩)——字段退化成普通字符串
    expect(typeof slidesOf(buildDoc('application/json', row!.inline_text)).get(0).get('body')).toBe('string')

    pc.close()
    pd.close()
    A.socket.destroy()
    B.socket.destroy()
  })

  it('正文标记 {"$text"}:建出来不等人打开就换成投影、字段是协同文本;agent 读到普通字符串,按文本改按字符并入', async () => {
    const marked = {
      title: { $text: '周会' },
      slides: [{ title: '一', body: { $text: 'hello world' } }],
      meta: { $text: 'x', k: 1 }, // 多一个键:普通对象,不是标记
    }
    const projected = { title: '周会', slides: [{ title: '一', body: 'hello world' }], meta: { $text: 'x', k: 1 } }
    const file = await fx.file(chat, u.a, 'marks.slides.json', 'application/json', JSON.stringify(marked))
    // 通知 files_item_marked ⇒ 服务马上建状态,同一条 UPDATE 把正文换成投影(没有任何人打开)
    expect(await waitFor(async () => ((await fx.row(file))?.ys ?? 0) > 0, 5000, 50)).toBeGreaterThanOrEqual(0)
    const row = await fx.row(file)
    expect(JSON.parse(row!.inline_text!)).toEqual(projected)
    expect(Number(row!.size_bytes)).toBe(Buffer.byteLength(row!.inline_text!))
    expect(row!.epoch).toBe(0)

    const ta = await issuer.mint(u.a)
    const read = await getFile(svc.url, ta, file)
    expect(JSON.parse(read.body.text as string)).toEqual(projected) // agent 读到的是普通字符串

    const A = machine(svc.url, ta)
    const pa = openPage(A, file, 0)
    await pa.synced
    expect(pa.doc.getMap('root').get('title')).toBeInstanceOf(Y.Text)
    expect(bodyOf(pa.doc, 0)).toBeInstanceOf(Y.Text)
    expect(pa.doc.getMap('root').get('meta')).toBeInstanceOf(Y.Map)

    // 页面在句末打字,agent 同时按文本改句首:按字符并入,两边的字都在,类型不变
    ;(bodyOf(pa.doc, 0) as Y.Text).insert(11, '!!')
    const edited = await editFile(svc.url, ta, file, '"body": "hello', '"body": "hi')
    expect(edited.status).toBe(200)
    expect(await waitFor(() => String(bodyOf(pa.doc, 0)) === 'hi world!!', 3000)).toBeGreaterThanOrEqual(0)
    expect(bodyOf(pa.doc, 0)).toBeInstanceOf(Y.Text)

    // agent 在编辑里新写一个标记:建成协同文本,正文里读到的是字符串
    expect((await editFile(svc.url, ta, file, '"title": "周会"', '"title": "周会",\n  "summary": {"$text": "要点"}')).status).toBe(200)
    expect(await waitFor(() => pa.doc.getMap('root').get('summary') instanceof Y.Text, 3000)).toBeGreaterThanOrEqual(0)
    expect(JSON.parse((await getFile(svc.url, ta, file)).body.text as string).summary).toBe('要点')

    pa.close()
    expect(await waitFor(async () => JSON.parse((await fx.row(file))!.inline_text!).summary === '要点', 10_000, 50)).toBeGreaterThanOrEqual(0)
    A.socket.destroy()
  })

  it('对照:没有标记的正文建状态时不改写(缩进、键序照旧,直到第一次存盘)', async () => {
    const pretty = JSON.stringify({ b: 1, a: { c: '$text 只是字' } }, null, 4)
    const file = await fx.file(chat, u.a, 'plain.json', 'application/json', pretty)
    const ta = await issuer.mint(u.a)
    const A = machine(svc.url, ta)
    const pa = openPage(A, file, 0)
    await pa.synced
    const row = await fx.row(file)
    expect(row!.ys).toBeGreaterThan(0)
    expect(row!.inline_text).toBe(pretty)
    pa.close()
    A.socket.destroy()
  })
})
