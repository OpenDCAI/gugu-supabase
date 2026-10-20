import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  Fixture,
  SEED,
  Typist,
  count,
  editFile,
  getFile,
  machine,
  openPage,
  filesConfig,
  sleep,
  startIssuer,
  startFiles,
  stats,
  waitFor,
  type Issuer,
  type Page,
  type Running,
} from './support.ts'

/**
 * E2(原型 e2-coedit 的本仓版):三个人 + 一个 agent 同时改一个 markdown 文件,B、C 大半时间挤在同一处打字。
 *   · A 在 t≈4 s 本地改第四句;agent 在 t≈1 s 读一次,「想」一会儿,t≈6 s 按读到的改第一到四句 —— 第四句已经被 A 改过。
 *   · 判据:三份副本、服务端内存、库里逐字节相同;每个打下的标记都完整且只出现一次;A 的改动与 agent 的改动都在。
 *   · 对照:agent 拿过期内容改第四句 ⇒ 409 content-changed,文件不动;重读后同一处改动 ⇒ 200,A 的改动仍在。
 * 原型的另一组对照(副本放在主进程、页面按位置号发操作 ⇒ 字落错位置)是客户端架构的事,归 L3 / L4 的回归,不在这里。
 */
const SECS = 9
const CPS = 8
let fx: Fixture
let issuer: Issuer
let svc: Running
const u = { a: '', b: '', c: '', owner: '', agent: '' }
let doc: string

beforeAll(async () => {
  fx = new Fixture()
  await fx.connect()
  issuer = await startIssuer()
  svc = await startFiles(filesConfig(await fx.filesLogin(), issuer.jwksUrl))
  u.a = await fx.person('E2 A')
  u.b = await fx.person('E2 B')
  u.c = await fx.person('E2 C')
  u.owner = await fx.person('E2 Owner')
  u.agent = await fx.agentOf(u.owner, 'E2 Agent')
  const chat = await fx.group(u.a, [u.b, u.c, u.agent])
  doc = await fx.file(chat, u.a, '协同测试.md', 'text/markdown', SEED)
})
afterAll(async () => {
  await svc?.close()
  await issuer?.close()
  await fx?.cleanup()
})

describe('E2 三人 + agent 同时编辑', () => {
  it('全部收敛、每个标记完整且只出现一次;过期的 edit 409、重读后成功,A 的改动保留', async () => {
    const tok = { a: await issuer.mint(u.a), b: await issuer.mint(u.b), c: await issuer.mint(u.c), owner: await issuer.mint(u.owner) }
    const machines = { a: machine(svc.url, tok.a, { ipcDelayMs: 2 }), b: machine(svc.url, tok.b, { ipcDelayMs: 2 }), c: machine(svc.url, tok.c, { ipcDelayMs: 2 }) }
    const pages: Record<'a' | 'b' | 'c', Page> = { a: openPage(machines.a, doc, 0), b: openPage(machines.b, doc, 0), c: openPage(machines.c, doc, 0) }
    await Promise.all(Object.values(pages).map((p) => p.synced))
    const s0 = await stats(svc.adminUrl)

    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const typed: string[] = []
    const t0 = Date.now()
    const until = t0 + SECS * 1000
    async function typist(name: 'a' | 'b' | 'c', spots: { anchor: string; fromMs?: number }[]) {
      let n = 0
      let spot = 0
      let ed = new Typist(pages[name], spots[0]!.anchor)
      while (Date.now() < until) {
        const next = spots[spot + 1]
        if (next && Date.now() - t0 > (next.fromMs ?? 0)) ed = new Typist(pages[name], spots[++spot]!.anchor)
        const token = `‹${name.toUpperCase()}${String(++n).padStart(2, '0')}›`
        for (const ch of token) {
          if (rnd() < 0.1) {
            ed.type('x') // 打错一个字再删掉
            await sleep(1000 / CPS)
            ed.backspace()
            await sleep(1000 / CPS)
          }
          ed.type(ch)
          await sleep(1000 / CPS)
        }
        ed.type(' ')
        typed.push(token)
        await sleep(1000 / CPS)
      }
    }
    async function aRewritesSentence4() {
      await sleep(4000)
      const t = pages.a.doc.getText('content')
      t.insert(t.toString().indexOf('撞车。') + 2, '（A 改过）')
    }
    const agentLog: { step: string; status: number; error?: string }[] = []
    async function agent() {
      await sleep(1000)
      const read = await getFile(svc.url, tok.owner, doc, u.agent)
      expect(read.status).toBe(200)
      await sleep(5000) // 「想」的时候,A 改了第四句
      const edits: [string, string][] = [
        ['第一句：今天的工作区只扛得住低频写。', '第一句：（agent）工作区改成文件服务后能扛高频写。'],
        ['第二句：每保存一次，整篇正文在网上走三遍。', '第二句：（agent）每次按键只发几十字节。'],
        ['第三句：通知推给全员，而不只推给正在看的人。', '第三句：（agent）只推给开着这个文件的人。'],
        ['第四句：人和 agent 会在这句上撞车。', '第四句：（agent）撞车时 edit 报错，重读再改。'],
      ]
      for (const [o, n] of edits) {
        const r = await editFile(svc.url, tok.owner, doc, o, n, u.agent)
        agentLog.push({ step: o.slice(0, 3), status: r.status, error: r.body.error })
        if (r.status === 409) {
          // 对照:文件没动 —— 过期的 old 不会覆盖 A 的改动。
          expect((await getFile(svc.url, tok.owner, doc, u.agent)).body.text).toContain('（A 改过）')
          const fresh = (await getFile(svc.url, tok.owner, doc, u.agent)).body.text as string
          const line = fresh.split('\n').find((l) => l.startsWith('第四句'))!
          const r2 = await editFile(svc.url, tok.owner, doc, line, line.replace('人和 agent 会在这句上撞车', '（agent）撞车时 edit 报错，重读再改'), u.agent)
          agentLog.push({ step: 'retry', status: r2.status, error: r2.body.error })
        }
      }
    }

    await Promise.all([
      typist('a', [{ anchor: '（A 在这段后面写）' }]),
      typist('b', [{ anchor: '（B 在这段后面写）' }, { anchor: '（C 在这段后面写）', fromMs: 1500 }]),
      typist('c', [{ anchor: '（C 在这段后面写）' }]),
      aRewritesSentence4(),
      agent(),
    ])
    const settle = await waitFor(() => pages.a.text() === pages.b.text() && pages.b.text() === pages.c.text(), 5000)
    expect(settle).toBeGreaterThanOrEqual(0)
    const final = pages.a.text()
    const live = await getFile(svc.url, tok.a, doc)
    expect(live.body).toMatchObject({ live: true, text: final })

    for (const p of Object.values(pages)) p.close()
    expect(await waitFor(async () => (await stats(svc.adminUrl)).documents === 0, 8000)).toBeGreaterThanOrEqual(0)
    const row = await fx.row(doc)
    expect(row!.inline_text).toBe(final)

    const broken = typed.filter((t) => count(final, t) !== 1)
    expect({ typed: typed.length >= 15, broken }).toEqual({ typed: true, broken: [] }) // 9 s × 8 字/秒 ≈ 每人 8–9 个标记
    expect(final).toContain('工作区改成文件服务后能扛高频写')
    expect(final).toContain('每次按键只发几十字节')
    expect(final).toContain('只推给开着这个文件的人')
    const line4 = final.split('\n').find((l) => l.startsWith('第四句'))!
    expect(line4).toContain('（A 改过）')
    expect(line4).toContain('（agent）撞车时 edit 报错，重读再改')
    expect(agentLog).toEqual([
      { step: '第一句', status: 200 },
      { step: '第二句', status: 200 },
      { step: '第三句', status: 200 },
      { step: '第四句', status: 409, error: 'content-changed' },
      { step: 'retry', status: 200 },
    ])
    const s1 = await stats(svc.adminUrl)
    expect(s1.storeLost - s0.storeLost).toBe(0)
    expect(s1.storeErrors - s0.storeErrors).toBe(0)
    for (const m of Object.values(machines)) m.socket.destroy()
  })
})
