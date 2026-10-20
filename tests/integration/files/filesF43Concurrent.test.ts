import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildDoc } from '../../../packages/files-core/src/content.mjs'
import {
  Fixture,
  editFile,
  filesConfig,
  getFile,
  machine,
  makeGate,
  openPage,
  sleep,
  startFiles,
  startIssuer,
  waitFor,
  type Gate,
  type Issuer,
  type Machine,
  type Page,
  type Running,
} from './support.ts'

/**
 * F43(设计 gugu-base notes/2026-09-29-app-platform/workspace-app/L2-F43-nested-create.md,统筹 09-30 批准):
 * 两端(人和人、人和 agent)同时第一次写同一条嵌套路径,两边写的都留下;看见旧值之后有意替换的,不修。
 * 真服务、真连接;「同时」靠合盖(帧两头都扣住)做出来。页面 A、B、C 的 clientID 固定为 1、2、3:
 * map 键冲突时 id 大的胜 ⇒ A 总是输家(迟到的写那一格要靠这一点)。页面和运行时一样装 keepReplacedMaps。
 * 规则:map 的键是地址,两边取并集;键上别的值(数组、文本、数字)后写者胜。阴性对照(不修 ⇒ 丢)在单测 concurrent.test.ts,
 * 同一套场景对改动前的服务跑一遍的读数记在 PR 里。
 */
let fx: Fixture
let issuer: Issuer
let svc: Running
let compacting: Running
const u = { a: '', b: '', c: '' }
let chat: string
const machines: Machine[] = []
const pages: Page[] = []

beforeAll(async () => {
  fx = new Fixture()
  await fx.connect()
  issuer = await startIssuer()
  const login = await fx.filesLogin()
  svc = await startFiles(filesConfig(login, issuer.jwksUrl, { timeoutMs: 3000 }))
  compacting = await startFiles(filesConfig(login, issuer.jwksUrl, { compactRatio: 0, compactMinBytes: 0 }))
  u.a = await fx.person('F43 A')
  u.b = await fx.person('F43 B')
  u.c = await fx.person('F43 C')
  chat = await fx.group(u.a, [u.b, u.c])
})
afterAll(async () => {
  for (const p of pages) p.close()
  for (const m of machines) m.socket.destroy()
  await svc?.close()
  await compacting?.close()
  await issuer?.close()
  await fx?.cleanup()
})

async function page(s: Running, who: string, file: string, clientID: number, gates: { gate?: Gate; inbound?: Gate } = {}) {
  const m = machine(s.url, await issuer.mint(who), gates)
  machines.push(m)
  const p = openPage(m, file, 0, { clientID })
  pages.push(p)
  await p.synced
  return p
}
const root = (p: Page) => p.doc.getMap('root')
/** 像运行时那样写一条路径:缺的中间 map 由写的这一端新建。 */
function write(p: Page, keys: string[], leafKey: string, leaf: unknown) {
  p.doc.transact(() => {
    let m = root(p)
    for (const k of keys) {
      if (!(m.get(k) instanceof Y.Map)) m.set(k, new Y.Map())
      m = m.get(k) as Y.Map<unknown>
    }
    m.set(leafKey, leaf)
  })
}
const json = (p: Page) => JSON.stringify(sortKeys(root(p).toJSON()))
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as any)[k])]))
  return v
}
/** 等到所有页面收敛成同一份,且满足 `pred`;返回那一份。 */
async function converged(ps: Page[], pred: (data: any) => boolean, ms = 8000) {
  const ok = await waitFor(() => new Set(ps.map(json)).size === 1 && pred(root(ps[0]).toJSON()), ms)
  expect(ok, `not converged: ${ps.map(json).join(' | ')}`).toBeGreaterThanOrEqual(0)
  return root(ps[0]).toJSON() as any
}
/** 两页(或三页)各自合盖写,再按给定顺序开盖:服务端依次收到,冲突在那里合并。 */
async function concurrently(ps: Page[], gates: Gate[], writes: (() => void)[]) {
  gates.forEach((g) => g.pause())
  writes.forEach((w) => w())
  for (const g of gates) {
    g.resume()
    await sleep(80)
  }
}
const merges = (s: Running) => ({ ...s.service.stats.concurrentMerges })

describe('F43 同时建同一条嵌套路径(真服务)', () => {
  it('两人同时第一次写 votes[10][user] ⇒ 两票都在', async () => {
    const file = await fx.file(chat, u.a, 'poll-1.json', 'application/json', '{"title":"poll"}')
    const [ga, gb] = [makeGate(), makeGate()]
    const A = await page(svc, u.a, file, 1, { gate: ga })
    const B = await page(svc, u.b, file, 2, { gate: gb })
    const before = merges(svc)
    await concurrently([A, B], [gb, ga], [() => write(A, ['votes', '10'], 'userA', 1), () => write(B, ['votes', '10'], 'userB', 1)])
    const data = await converged([A, B], (d) => Object.keys(d.votes?.['10'] ?? {}).length === 2)
    expect(data.votes).toEqual({ '10': { userA: 1, userB: 1 } })
    expect(merges(svc).create).toBeGreaterThan(before.create)
  })

  it('更深一层:a.b.c 下各写一个叶子 ⇒ 都在', async () => {
    const file = await fx.file(chat, u.a, 'deep.json', 'application/json', '{"title":"deep"}')
    const [ga, gb] = [makeGate(), makeGate()]
    const A = await page(svc, u.a, file, 1, { gate: ga })
    const B = await page(svc, u.b, file, 2, { gate: gb })
    await concurrently([A, B], [gb, ga], [() => write(A, ['a', 'b', 'c'], 'x', 1), () => write(B, ['a', 'b', 'c'], 'y', 2)])
    expect((await converged([A, B], (d) => Object.keys(d.a?.b?.c ?? {}).length === 2)).a).toEqual({ b: { c: { x: 1, y: 2 } } })
  })

  it('数组是值:两边同时给同一个键赋一个数组 ⇒ 后写者胜,不拼接、不合并', async () => {
    const file = await fx.file(chat, u.a, 'list.json', 'application/json', '{"title":"list"}')
    const [ga, gb] = [makeGate(), makeGate()]
    const A = await page(svc, u.a, file, 1, { gate: ga })
    const B = await page(svc, u.b, file, 2, { gate: gb })
    const before = merges(svc)
    const assign = (p: Page, by: string) => () => p.doc.transact(() => { const s = new Y.Array(); root(p).set('list', s); s.push([{ by }]) })
    await concurrently([A, B], [gb, ga], [assign(A, 'A'), assign(B, 'B')])
    const data = await converged([A, B], (d) => d.list?.length === 1)
    expect(data.list).toEqual([{ by: 'B' }])
    await sleep(300)
    expect(merges(svc)).toEqual(before)
  })

  it('数组元素里的对象,两边同时加 meta ⇒ 都在', async () => {
    const file = await fx.file(chat, u.a, 'slides.json', 'application/json', '{"slides":[{"title":"一"}]}')
    const [ga, gb] = [makeGate(), makeGate()]
    const A = await page(svc, u.a, file, 1, { gate: ga })
    const B = await page(svc, u.b, file, 2, { gate: gb })
    const el = (p: Page) => (root(p).get('slides') as Y.Array<Y.Map<unknown>>).get(0)
    const meta = (p: Page, k: string) => () => p.doc.transact(() => { const m = new Y.Map(); el(p).set('meta', m); m.set(k, 1) })
    await concurrently([A, B], [gb, ga], [meta(A, 'a'), meta(B, 'b')])
    expect((await converged([A, B], (d) => Object.keys(d.slides?.[0]?.meta ?? {}).length === 2)).slides[0]).toEqual({ title: '一', meta: { a: 1, b: 1 } })
  })

  it('人和 agent:页面合盖写 votes[10][userA],agent 同时按文本加 votes[10][agent] ⇒ 两个都在', async () => {
    const file = await fx.file(chat, u.a, 'poll-agent.json', 'application/json', '{"title":"poll"}')
    const ga = makeGate()
    const A = await page(svc, u.a, file, 1, { gate: ga })
    ga.pause()
    write(A, ['votes', '10'], 'userA', 1)
    const t = await issuer.mint(u.b)
    const edited = await editFile(svc.url, t, file, '"title": "poll"', '"title": "poll",\n  "votes": {\n    "10": {\n      "agent": 1\n    }\n  }')
    expect(edited.status).toBe(200)
    ga.resume()
    const data = await converged([A], (d) => Object.keys(d.votes?.['10'] ?? {}).length === 2)
    expect(data.votes['10']).toEqual({ agent: 1, userA: 1 })
    expect(JSON.parse((await getFile(svc.url, t, file)).body.text as string).votes['10']).toEqual({ agent: 1, userA: 1 })
  })

  it('三方同时建同一条路径 ⇒ 三票都在', async () => {
    const file = await fx.file(chat, u.a, 'poll-3.json', 'application/json', '{"title":"poll"}')
    const gates = [makeGate(), makeGate(), makeGate()]
    const ps = [
      await page(svc, u.a, file, 1, { gate: gates[0] }),
      await page(svc, u.b, file, 2, { gate: gates[1] }),
      await page(svc, u.c, file, 3, { gate: gates[2] }),
    ]
    await concurrently(ps, gates, ps.map((p, i) => () => write(p, ['votes', '10'], `user${'ABC'[i]}`, 1)))
    expect((await converged(ps, (d) => Object.keys(d.votes?.['10'] ?? {}).length === 3)).votes['10']).toEqual({ userA: 1, userB: 1, userC: 1 })
  })

  it('迟到的写:输的一端还听不到回音,继续往自己那个 map 里写 ⇒ 也都在', async () => {
    const file = await fx.file(chat, u.a, 'poll-late.json', 'application/json', '{"title":"poll"}')
    const [inA, gb] = [makeGate(), makeGate()]
    const A = await page(svc, u.a, file, 1, { inbound: inA })
    const B = await page(svc, u.b, file, 2, { gate: gb })
    const before = merges(svc)
    inA.pause() // A 发得出去,听不到回音
    gb.pause()
    write(B, ['votes', '10'], 'userB', 1)
    write(A, ['votes', '10'], 'userA', 1) // 先到服务端
    await sleep(150)
    gb.resume() // B 的到了:B(id 2)胜,A 那个 map 输,服务端合并
    expect(await waitFor(() => merges(svc).create > before.create, 5000)).toBeGreaterThanOrEqual(0)
    write(A, ['votes', '10'], 'userA2', 2) // A 还不知道:仍写进自己那个已经输掉的 map
    write(A, ['votes'], 'note', 'late')
    expect(await waitFor(() => merges(svc).lateWrite > before.lateWrite, 5000)).toBeGreaterThanOrEqual(0)
    inA.resume()
    const data = await converged([A, B], (d) => Object.keys(d.votes?.['10'] ?? {}).length === 3 && d.votes?.note === 'late')
    expect(data.votes).toEqual({ '10': { userA: 1, userA2: 2, userB: 1 }, note: 'late' })
  })

  it('离线的一端过了很久才重连(服务端早已断开它、存盘、卸载)⇒ 冲突照样修好', async () => {
    const file = await fx.file(chat, u.a, 'poll-offline.json', 'application/json', '{"title":"poll"}')
    const ga = makeGate()
    const A = await page(svc, u.a, file, 1, { gate: ga })
    ga.pause() // 合盖
    write(A, ['votes', '10'], 'userA', 1)
    const B = await page(svc, u.b, file, 2)
    write(B, ['votes', '10'], 'userB', 1)
    B.close()
    // 服务端 3 s 收不到 A 的心跳就断开它;B 也走了 ⇒ 存盘、卸载
    expect(await waitFor(() => !svc.service.hocuspocus.documents.has(`${file}@0`), 20_000, 100)).toBeGreaterThanOrEqual(0)
    expect(JSON.parse((await fx.row(file))!.inline_text!).votes['10']).toEqual({ userB: 1 })
    ga.resume() // 开盖:重连、补同步,冲突在重新加载的文档里合并
    const data = await converged([A], (d) => Object.keys(d.votes?.["10"] ?? {}).length === 2, 15_000)
    expect(data.votes['10']).toEqual({ userA: 1, userB: 1 })
  })

  it('对照:看见旧值之后有意重置成 {} ⇒ 保持 {},不修、不复活', async () => {
    const file = await fx.file(chat, u.a, 'poll-reset.json', 'application/json', '{"title":"poll"}')
    const A = await page(svc, u.a, file, 1)
    const B = await page(svc, u.b, file, 2)
    write(A, ['votes', '10'], 'userA', 1)
    await converged([A, B], (d) => d.votes?.['10']?.userA === 1)
    const before = merges(svc)
    B.doc.transact(() => root(B).set('votes', new Y.Map()))
    await converged([A, B], (d) => d.votes && Object.keys(d.votes).length === 0)
    await sleep(300)
    expect(json(A)).toBe(JSON.stringify({ title: 'poll', votes: {} }))
    expect(merges(svc)).toEqual(before)
  })
})

describe('F43 修过的文件冷压缩', () => {
  it('修复时留下的输家随冷压缩一起清掉:ystate 回到按内容新建的大小', async () => {
    const file = await fx.file(chat, u.a, 'poll-compact.json', 'application/json', '{"title":"poll"}')
    const [ga, gb] = [makeGate(), makeGate()]
    const A = await page(compacting, u.a, file, 1, { gate: ga })
    const B = await page(compacting, u.b, file, 2, { gate: gb })
    await concurrently([A, B], [gb, ga], [
      () => A.doc.transact(() => { const m = new Y.Map(); root(A).set('votes', m); for (let i = 0; i < 200; i++) m.set(`a${i}`, 'x'.repeat(40)) }),
      () => write(B, ['votes'], 'b', 1),
    ])
    await converged([A, B], (d) => Object.keys(d.votes ?? {}).length === 201)
    A.close()
    B.close()
    expect(await waitFor(async () => (await fx.row(file))?.epoch === 1, 15_000, 100)).toBeGreaterThanOrEqual(0)
    const row = (await fx.row(file))!
    const data = JSON.parse(row.inline_text!)
    expect(Object.keys(data.votes)).toHaveLength(201)
    const fresh = Y.encodeStateAsUpdate(buildDoc('application/json', row.inline_text)).length
    expect(row.ys!).toBeLessThanOrEqual(fresh * 1.1)
  })
})
