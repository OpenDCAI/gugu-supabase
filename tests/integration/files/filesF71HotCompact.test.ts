import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  Fixture,
  compactAware,
  editFile,
  filesConfig,
  getFile,
  machine,
  openPage,
  sleep,
  startFiles,
  startIssuer,
  waitFor,
  type Issuer,
  type Page,
  type Running,
} from './support.ts'

/**
 * F71 文件开着时的热压缩(gugu-base notes/2026-09-29-app-platform/workspace-app/L2-F71-hot-compaction.md),服务端这一半:
 *   · 每条连接都排空 ⇒ 换代:epoch + 1,库里是重建后的状态,连接以 compacted:<n> 关掉,新代号上内容一字不差;
 *   · 有一页一直不回 drained ⇒ 超时作废:所有页收到 resume,epoch 不变,内容照常。
 * 页面这一半(暂停、影子、重放)在 gugu 的运行时里;这里的页面用 support.ts 的 compactAware 照页面约定回应。
 * 阈值调低:正文很短、墓碑一多(反复插了又删)就超过 max(1 × 正文, 2 KB)。
 */
let fx: Fixture
let issuer: Issuer
let svc: Running
const u = { a: '', b: '' }
let chat: string

beforeAll(async () => {
  fx = new Fixture()
  await fx.connect()
  issuer = await startIssuer()
  svc = await startFiles(
    filesConfig(await fx.filesLogin(), issuer.jwksUrl, {
      hotCompactRatio: 1,
      hotCompactMinBytes: 2048,
      hotCompactCooldownMs: 0,
      compactDrainMs: 400,
      debounceMs: 100,
      maxDebounceMs: 300,
      // churn 一口气发几百条更新;这里验的是换代,不是限速(限速有 E5 那几格)。
      rateUpdates: { perSecond: 5000, burst: 50_000 },
    }),
  )
  u.a = await fx.person('F71 A')
  u.b = await fx.person('F71 B')
  chat = await fx.group(u.a, [u.b])
})
afterAll(async () => {
  await svc?.close()
  await issuer?.close()
  await fx?.cleanup()
})

/** 在句首反复插一段又删掉:正文不变,墓碑越积越多(各处的字互不相邻,Yjs 合并不了)。 */
async function churn(page: Page, rounds: number) {
  const text = page.doc.getText('content')
  for (let i = 0; i < rounds; i++) {
    text.insert(i % 3, `#${i}#`)
    text.delete(i % 3, `#${i}#`.length)
    if (i % 20 === 0) await sleep(5)
  }
}

describe('F71 热压缩:服务端这一半', () => {
  it('每条连接都排空 ⇒ 换代:epoch + 1,连接以 compacted 关掉,新代号上内容一字不差', async () => {
    const file = await fx.file(chat, u.a, 'hot.md', 'text/markdown', 'hello world\n')
    const A = machine(svc.url, await issuer.mint(u.a))
    const B = machine(svc.url, await issuer.mint(u.b))
    const pa = openPage(A, file, 0)
    const pb = openPage(B, file, 0)
    const sa = compactAware(pa)
    const sb = compactAware(pb)
    await Promise.all([pa.synced, pb.synced])
    pa.doc.getText('content').insert(0, 'A:')
    pb.doc.getText('content').insert(pb.text().length, ':B')
    await churn(pa, 400)
    expect(await waitFor(async () => (await fx.row(file))?.epoch === 1, 8000, 50)).toBeGreaterThanOrEqual(0)
    expect(await waitFor(() => pa.events.closed !== null && pb.events.closed !== null, 3000)).toBeGreaterThanOrEqual(0)
    expect(pa.events.closed!.reason).toBe('compacted:1')
    expect(pb.events.closed!.reason).toBe('compacted:1')
    expect(sa.compact).toBe(1)
    expect(sb.compact).toBe(1)
    expect(svc.service.stats.hotCompactions).toBeGreaterThanOrEqual(1)
    // 库里:重建后的状态比压缩前小得多,投影与两页看到的一致
    const row = await fx.row(file)
    expect(row!.inline_text).toBe(pa.text())
    expect(pa.text()).toBe(pb.text())
    expect(pa.text()).toBe('A:hello world\n:B')
    expect(row!.ys!).toBeLessThan(2048)
    // 新代号上重开:内容一字不差,还能照常协同
    const pc = openPage(A, file, 1)
    const pd = openPage(B, file, 1)
    await Promise.all([pc.synced, pd.synced])
    expect(pc.text()).toBe('A:hello world\n:B')
    pc.doc.getText('content').insert(0, '✓')
    expect(await waitFor(() => pd.text().startsWith('✓A:'), 3000)).toBeGreaterThanOrEqual(0)
    // 旧代号连不进来了
    const stale = openPage(machine(svc.url, await issuer.mint(u.a)), file, 0)
    expect(await waitFor(() => stale.events.authFailed !== null, 3000)).toBeGreaterThanOrEqual(0)
    expect(stale.events.authFailed!.reason).toBe('stale-epoch:1')
    for (const p of [pa, pb, pc, pd, stale]) p.close()
    A.socket.destroy()
    B.socket.destroy()
  })

  it('有一页一直不回 drained ⇒ 超时作废:所有页收到 resume,epoch 不变,内容照常', async () => {
    const file = await fx.file(chat, u.a, 'abort.md', 'text/markdown', 'keep me\n')
    const A = machine(svc.url, await issuer.mint(u.a))
    const B = machine(svc.url, await issuer.mint(u.b))
    const pa = openPage(A, file, 0)
    const pb = openPage(B, file, 0)
    const sa = compactAware(pa)
    const sb = compactAware(pb, { respond: false }) // 正在组字、或者卡住的页
    await Promise.all([pa.synced, pb.synced])
    const aborted0 = svc.service.stats.compactAborted
    await churn(pa, 400)
    expect(await waitFor(() => svc.service.stats.compactAborted > aborted0, 8000, 50)).toBeGreaterThanOrEqual(0)
    expect(await waitFor(() => sa.resume >= 1 && sb.resume >= 1, 2000)).toBeGreaterThanOrEqual(0)
    expect(sb.compact).toBeGreaterThanOrEqual(1)
    await sleep(300)
    expect((await fx.row(file))!.epoch).toBe(0)
    expect(pa.events.closed).toBeNull()
    expect(pb.events.closed).toBeNull()
    // 作废之后照常协同,什么都没丢
    pb.doc.getText('content').insert(0, 'B!')
    expect(await waitFor(() => pa.text() === 'B!keep me\n', 3000)).toBeGreaterThanOrEqual(0)
    pa.close()
    pb.close()
    A.socket.destroy()
    B.socket.destroy()
  })

  it('agent 的 HTTP edit 撞上换代:等它结束,在新代号上恰好落一次', async () => {
    const file = await fx.file(chat, u.a, 'edit.md', 'text/markdown', 'target line\n')
    const A = machine(svc.url, await issuer.mint(u.a))
    const pa = openPage(A, file, 0)
    compactAware(pa)
    await pa.synced
    const token = await issuer.mint(u.a)
    await churn(pa, 400)
    // 墓碑刚攒够、压缩随时会开始时来一次 edit:它要么落在换代之前(被新状态带走),要么等换代完在新代号上落
    const edit = editFile(svc.url, token, file, 'target line', 'edited line')
    expect((await edit).status).toBe(200)
    expect(await waitFor(async () => (await fx.row(file))?.epoch === 1, 8000, 50)).toBeGreaterThanOrEqual(0)
    await sleep(500)
    const read = await getFile(svc.url, token, file)
    expect(read.body.text).toBe('edited line\n')
    expect((read.body.text as string).split('edited').length - 1).toBe(1)
    pa.close()
    A.socket.destroy()
  })
})
