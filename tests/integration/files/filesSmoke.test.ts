import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  Fixture,
  SEED,
  Typist,
  editFile,
  getFile,
  machine,
  openPage,
  filesConfig,
  startIssuer,
  startFiles,
  stats,
  typeString,
  waitFor,
  type Issuer,
  type Running,
} from './support.ts'

/** 冒烟:两台机器同开一个文件、agent 经 HTTP 读改、关掉后库里是同一份。 */
let fx: Fixture
let issuer: Issuer
let svc: Running
let a: string
let b: string
let chat: string
let doc: string

beforeAll(async () => {
  fx = new Fixture()
  await fx.connect()
  issuer = await startIssuer()
  svc = await startFiles(filesConfig(await fx.filesLogin(), issuer.jwksUrl))
  a = await fx.person('Smoke A')
  b = await fx.person('Smoke B')
  chat = await fx.group(a, [b])
  doc = await fx.file(chat, a, 'smoke.md', 'text/markdown', SEED)
})
afterAll(async () => {
  await svc?.close()
  await issuer?.close()
  await fx?.cleanup()
})

describe('files smoke', () => {
  it('两台机器同开、互相看见;agent 读到正在编辑的内容;关掉后库里与副本逐字节相同', async () => {
    const ta = await issuer.mint(a)
    const tb = await issuer.mint(b)
    const meta = await getFile(svc.url, ta, doc)
    expect(meta).toMatchObject({ status: 200, body: { epoch: 0, contentType: 'text/markdown', text: SEED, live: false } })

    const A = machine(svc.url, ta)
    const B = machine(svc.url, tb)
    const pa = openPage(A, doc, 0)
    const pb = openPage(B, doc, 0)
    await Promise.all([pa.synced, pb.synced])
    expect(pa.text()).toBe(SEED)

    await typeString(new Typist(pa, '（A 在这段后面写）'), '‹smoke›', 50)
    expect(await waitFor(() => pb.text().includes('‹smoke›'), 3000)).toBeGreaterThanOrEqual(0)

    const live = await getFile(svc.url, tb, doc)
    expect(live.body).toMatchObject({ live: true })
    expect(live.body.text).toContain('‹smoke›')

    const edited = await editFile(svc.url, tb, doc, '第一句：今天的工作区只扛得住低频写。', '第一句：（冒烟）改过了。')
    expect(edited).toMatchObject({ status: 200, body: { ok: true, epoch: 0 } })
    expect(await waitFor(() => pa.text().includes('（冒烟）改过了'), 3000)).toBeGreaterThanOrEqual(0)

    pa.close()
    pb.close()
    expect(await waitFor(async () => (await stats(svc.adminUrl)).documents === 0, 8000)).toBeGreaterThanOrEqual(0)
    const row = await fx.row(doc)
    expect(row!.inline_text).toBe(pb.text())
    expect(Number(row!.size_bytes)).toBe(Buffer.byteLength(pb.text()))
    expect(row!.ys).toBeGreaterThan(0)
    A.socket.destroy()
    B.socket.destroy()
  })
})
