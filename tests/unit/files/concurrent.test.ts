import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'

import { keepReplacedMaps, mergeConcurrentCreations } from '../../../packages/files-core/src/concurrent.mjs'
import { buildDoc, rebuildDoc } from '../../../packages/files-core/src/content.mjs'

/**
 * F43 同时建同一条嵌套路径(设计 gugu-base notes/2026-09-29-app-platform/workspace-app/L2-F43-nested-create.md)。
 * 每一格跑两遍:什么都不装 ⇒ 丢一边(阴性对照,也就是今天);hub 装修复、页面装 keepReplacedMaps(和运行时一样)⇒ 两边都在。
 * 规则只有一条:map 的键是地址,两边取并集;键上别的值(数组、文本、数字)后写者胜。
 * 页面只和 hub 通信,和文件服务的拓扑一样;A、B、C 的 clientID 固定,map 键冲突时 id 大的胜 ⇒ A 总是输家。
 */
type Pages = { hub: Y.Doc; A: Y.Doc; B: Y.Doc; C: Y.Doc; up: (p: Y.Doc) => void; down: (p: Y.Doc) => void }
const tick = () => new Promise((r) => setTimeout(r, 0))

async function run(repair: boolean | { hub: boolean; page: boolean }, steps: (p: Pages) => Promise<void> | void) {
  const { hub: onHub, page: onPage } = typeof repair === 'boolean' ? { hub: repair, page: repair } : repair
  const hub = new Y.Doc()
  hub.getMap('root').set('title', 'poll')
  const merges: string[] = []
  if (onHub) mergeConcurrentCreations(hub, { onMerge: (kind) => merges.push(kind) })
  const [A, B, C] = [1, 2, 3].map((id) => {
    const d = new Y.Doc()
    if (onPage) keepReplacedMaps(d)
    d.clientID = id
    Y.applyUpdate(d, Y.encodeStateAsUpdate(hub))
    return d
  })
  const up = (p: Y.Doc) => Y.applyUpdate(hub, Y.encodeStateAsUpdate(p, Y.encodeStateVector(hub)))
  const down = (p: Y.Doc) => Y.applyUpdate(p, Y.encodeStateAsUpdate(hub, Y.encodeStateVector(p)))
  await steps({ hub, A, B, C, up, down })
  await tick()
  for (let i = 0; i < 2; i++) for (const p of [A, B, C]) { down(p); up(p) }
  await tick()
  for (const p of [A, B, C]) down(p)
  const json = (d: Y.Doc) => d.getMap('root').toJSON()
  for (const p of [A, B, C]) expect(json(p)).toEqual(json(hub)) // 收敛
  return { data: json(hub), merges, hub }
}
/** 像运行时那样写一条路径:缺的中间 map 由写的这一端新建。 */
const write = (doc: Y.Doc, keys: string[], leafKey: string, leaf: unknown) =>
  doc.transact(() => {
    let m = doc.getMap('root')
    for (const k of keys) {
      if (!(m.get(k) instanceof Y.Map)) m.set(k, new Y.Map())
      m = m.get(k) as Y.Map<unknown>
    }
    m.set(leafKey, leaf)
  })

const cases: [string, (p: Pages) => Promise<void> | void, (data: any) => void, (data: any) => void][] = [
  [
    '两页同时第一次写 votes[10][user]',
    ({ A, B, up }) => { write(A, ['votes', '10'], 'userA', 1); write(B, ['votes', '10'], 'userB', 1); up(A); up(B) },
    (d) => expect(d.votes['10']).toEqual({ userB: 1 }),
    (d) => expect(d.votes['10']).toEqual({ userA: 1, userB: 1 }),
  ],
  [
    '更深:a.b.c 下各写一个叶子',
    ({ A, B, up }) => { write(A, ['a', 'b', 'c'], 'x', 1); write(B, ['a', 'b', 'c'], 'y', 2); up(A); up(B) },
    (d) => expect(d.a.b.c).toEqual({ y: 2 }),
    (d) => expect(d.a.b.c).toEqual({ x: 1, y: 2 }),
  ],
  [
    '数组元素里的对象,两边同时加 meta',
    async ({ hub, A, B, up, down }) => {
      hub.transact(() => { const s = new Y.Array(); hub.getMap('root').set('slides', s); s.push([new Y.Map()]) })
      down(A); down(B)
      const el = (d: Y.Doc) => (d.getMap('root').get('slides') as Y.Array<Y.Map<unknown>>).get(0)
      A.transact(() => { const m = new Y.Map(); el(A).set('meta', m); m.set('a', 1) })
      B.transact(() => { const m = new Y.Map(); el(B).set('meta', m); m.set('b', 2) })
      up(A); up(B)
    },
    (d) => expect(d.slides[0].meta).toEqual({ b: 2 }),
    (d) => expect(d.slides[0].meta).toEqual({ a: 1, b: 2 }),
  ],
  [
    '人和 agent:agent 的 edit 先在 hub 里建了中间 map',
    ({ hub, A, up }) => { write(hub, ['votes', '10'], 'agent', 1); write(A, ['votes', '10'], 'userA', 1); up(A) },
    (d) => expect(d.votes['10']).not.toHaveProperty('userA'),
    (d) => expect(d.votes['10']).toMatchObject({ agent: 1, userA: 1 }),
  ],
  [
    '三方同时建同一条路径',
    ({ A, B, C, up }) => { write(A, ['votes', '10'], 'userA', 1); write(B, ['votes', '10'], 'userB', 1); write(C, ['votes', '10'], 'userC', 1); up(A); up(B); up(C) },
    (d) => expect(Object.keys(d.votes['10'])).toHaveLength(1),
    (d) => expect(d.votes['10']).toEqual({ userA: 1, userB: 1, userC: 1 }),
  ],
  [
    '输的一端还不知道自己输了,继续往自己那个 map 里写(迟到的写)',
    async ({ A, B, up }) => {
      write(B, ['votes', '10'], 'userB', 1); up(B)
      write(A, ['votes', '10'], 'userA', 1); up(A) // hub 在这里判了:A 的 map 输
      await tick()
      write(A, ['votes', '10'], 'userA2', 2) // A 还没收到:本地仍是自己那个 map
      write(A, ['votes'], 'note', 'late')
      up(A) // 到 hub 时它们的父级已经删了
    },
    (d) => expect(d.votes).toEqual({ '10': { userB: 1 } }),
    (d) => expect(d.votes).toEqual({ '10': { userA: 1, userA2: 2, userB: 1 }, note: 'late' }),
  ],
]

describe('F43 同时建同一条嵌套路径', () => {
  for (const [name, steps, today, fixed] of cases) {
    it(`${name}:不修 ⇒ 丢一边;修 ⇒ 两边都在`, async () => {
      today((await run(false, steps)).data)
      const r = await run(true, steps)
      fixed(r.data)
      expect(r.merges.length).toBeGreaterThan(0)
    })
  }

  it('对照:看见旧值之后有意替换(重置成 {})不修,也不把删掉的复活', async () => {
    const steps = async ({ A, B, up, down }: Pages) => {
      write(A, ['votes', '10'], 'userA', 1); up(A); down(B)
      B.transact(() => B.getMap('root').set('votes', new Y.Map()))
      up(B)
    }
    for (const repair of [false, true]) {
      const r = await run(repair, steps)
      expect(r.data.votes).toEqual({})
      expect(r.merges).toEqual([])
    }
  })

  it('离线的一端重连时先收到胜者、本地先判自己输了:页面不装 keepReplacedMaps,只在 hub 修也救不回;装上就两边都在', async () => {
    const steps = ({ A, B, up, down }: Pages) => {
      write(A, ['votes', '10'], 'userA', 1) // A 离线时写的
      write(B, ['votes', '10'], 'userB', 1); up(B)
      down(A) // 重连:先收到 hub 的(B 的 map 胜,A 自己那个在本地被删)
      up(A) // 然后才把自己的发上去
    }
    expect((await run(false, steps)).data.votes['10']).toEqual({ userB: 1 })
    const hubOnly = await run({ hub: true, page: false }, steps)
    expect(hubOnly.data.votes['10']).toEqual({ userB: 1 }) // 自己那份在本地就被 GC 了,送不到 hub
    expect(hubOnly.merges).toEqual([])
    const both = await run(true, steps)
    expect(both.data.votes['10']).toEqual({ userA: 1, userB: 1 })
  })

  it('数组是值:两边同时给同一个键赋一个数组,后写者胜(修不修都一样,不拼接)', async () => {
    const steps = ({ A, B, up }: Pages) => {
      for (const [d, by] of [[A, 'A'], [B, 'B']] as const) d.transact(() => { const s = new Y.Array(); d.getMap('root').set('list', s); s.push([{ by }]) })
      up(A); up(B)
    }
    for (const repair of [false, true]) {
      const r = await run(repair, steps)
      expect(r.data.list).toEqual([{ by: 'B' }])
      expect(r.merges).toEqual([])
    }
  })

  it('迟到的写里整块新建的 map(连同子项)也转写进胜者', async () => {
    const r = await run(true, async ({ A, B, up }) => {
      write(B, ['votes', '10'], 'userB', 1); up(B)
      write(A, ['votes', '10'], 'userA', 1); up(A)
      await tick()
      write(A, ['votes', '11', 'deep'], 'x', 1) // 在已经输掉的 map 下新建 11 → deep → x
      up(A)
    })
    expect(r.data.votes).toEqual({ '10': { userA: 1, userB: 1 }, '11': { deep: { x: 1 } } })
  })

  it('同一个叶子两边都写了:胜者留下(和今天一样,不造第三种值)', async () => {
    const r = await run(true, ({ A, B, up }) => { write(A, ['votes', '10'], 'same', 'A'); write(B, ['votes', '10'], 'same', 'B'); up(A); up(B) })
    expect(r.data.votes['10']).toEqual({ same: 'B' })
  })

  it('修过的输家不做 GC(迟到的写要靠它),冷压缩按当前结构重建后回到正常大小', async () => {
    const r = await run(true, ({ A, B, up }) => {
      A.transact(() => { const m = new Y.Map(); A.getMap('root').set('votes', m); for (let i = 0; i < 200; i++) m.set(`a${i}`, 'x'.repeat(40)) })
      write(B, ['votes'], 'b', 1)
      up(A); up(B)
    })
    expect(Object.keys(r.data.votes)).toHaveLength(201)
    const kept = Y.encodeStateAsUpdate(r.hub).length
    const compacted = Y.encodeStateAsUpdate(rebuildDoc(r.hub, 'application/json')).length
    const fresh = Y.encodeStateAsUpdate(buildDoc('application/json', JSON.stringify(r.data))).length
    expect(kept).toBeGreaterThan(fresh * 1.5) // 输家那份 200 条还留在状态里
    expect(compacted).toBeLessThanOrEqual(fresh * 1.1) // 压缩之后和按内容新建的差不多大
  })
})

describe('F61 keepReplacedMaps 只留「被别的值顶掉」的 map', () => {
  const big = 'x'.repeat(2000)
  const size = (d: Y.Doc) => Y.encodeStateAsUpdate(d).length
  const fresh = (keep: boolean) => {
    const d = new Y.Doc()
    if (keep) keepReplacedMaps(d)
    return d
  }
  const setMap = (d: Y.Doc, key: string, entries: Record<string, unknown>) =>
    d.transact(() => {
      const m = new Y.Map()
      d.getMap('root').set(key, m)
      for (const [k, v] of Object.entries(entries)) m.set(k, v)
    })

  it('直接 delete 掉的 map 被回收(对照:什么都不回收的文档里它还在)', () => {
    const d = fresh(true)
    setMap(d, 'x', { a: big })
    d.transact(() => d.getMap('root').delete('x'))
    expect(size(d)).toBeLessThan(500)
    const control = new Y.Doc({ gc: false })
    setMap(control, 'x', { a: big })
    control.transact(() => control.getMap('root').delete('x'))
    expect(size(control)).toBeGreaterThan(2000)
  })

  it('被别的值顶掉的 map 仍然保留(迟到的写、离线重连要靠它)', () => {
    const d = fresh(true)
    setMap(d, 'x', { a: big })
    setMap(d, 'x', { b: 2 })
    expect(size(d)).toBeGreaterThan(2000)
    expect(d.getMap('root').toJSON()).toEqual({ x: { b: 2 } })
  })

  it('先被顶掉、之后整个键又被删:被顶掉的那个留着,直接删掉的那个回收', () => {
    const d = fresh(true)
    setMap(d, 'x', { a: big })
    setMap(d, 'x', { b: big })
    d.transact(() => d.getMap('root').delete('x'))
    const s = size(d)
    expect(s).toBeGreaterThan(2000) // a 还在
    expect(s).toBeLessThan(4000) // b 没留
  })
})
