import { describe, expect, it } from 'vitest'

import { createRounds } from '../../../services/files/src/rounds.mjs'

/**
 * G2「一轮」(144 10-11 02:23):只在 agent 那一轮的边界(开始改、改完了、换了另一个 agent)和「任何人停了 idleMs」时切;
 * 人和人之间换手不切。上一轮改完的样子在下一轮第一笔之前记成一版,作者是那一轮最后改的那位;还没结束的那一轮不记
 * (它就是文件现在的样子);服务起来后第一笔改动之前记一次(作者不明 = null)。卸载不切:那是 files.mjs 的事,这里没有卸载。写入排队、不等:before 同步返回,正文在那一刻读出。时间全由注入的时钟给,不用墙钟。
 * 对照(变异):把「同一个 key、没停够」的提前返回去掉,前两格的记录数会变成每笔一次;把 before 里的 sweep 去掉,
 * 最后一格的 size 停在 2、x 那一版记不下来。
 */
const A = { id: 'A', agent: false }
const B = { id: 'B', agent: false }
const BOT = { id: 'bot', agent: true }
const BOT2 = { id: 'bot2', agent: true }

function harness(idleMs = 30_000) {
  let clock = 0
  let text = 'v0'
  const recorded: [string, string | null][] = []
  const errors: unknown[] = []
  let fail: string | null = null
  const rounds = createRounds({
    idleMs,
    now: () => clock,
    record: async (_itemId: string, t: string, by: string | null) => {
      if (t === fail) throw new Error('db down')
      recorded.push([t, by])
    },
    read: () => text,
    onError: (_itemId: string, error: unknown) => void errors.push(error),
  })
  return {
    recorded,
    errors,
    failOn: (t: string) => (fail = t),
    tick: (ms: number) => (clock += ms),
    write: (writer: { id: string; agent: boolean }, next: string, changes?: () => boolean) => {
      rounds.before('item', writer, () => text, changes)
      text = next
    },
    settled: () => rounds.settled('item'),
  }
}

describe('rounds (G2)', () => {
  it('A、B 两人交替打 300 次,每 200 ms 一下(一分钟,谁都没停够 30 s):只记第一笔之前那一版;agent 接手时这 300 下记成一版', async () => {
    const h = harness()
    for (let i = 0; i < 300; i++) {
      h.tick(200)
      h.write(i % 2 ? B : A, `v${i + 1}`)
    }
    await h.settled()
    expect(h.recorded).toEqual([['v0', null]])
    h.tick(200)
    h.write(BOT, 'bot')
    await h.settled()
    expect(h.recorded).toEqual([['v0', null], ['v300', 'B']])
  })

  it('agent 改一轮夹在人改的中间:agent 改之前、改完之后各成一版,作者对得上;agent 那一轮里多少笔都是一版', async () => {
    const h = harness()
    h.write(A, 'A1'); h.tick(1000)
    h.write(B, 'AB'); h.tick(1000)
    for (let i = 0; i < 5; i++) { h.write(BOT, `bot${i}`); h.tick(300) }
    h.write(A, 'after'); h.tick(1000)
    h.write(B, 'after2')
    await h.settled()
    expect(h.recorded).toEqual([
      ['v0', null],
      ['AB', 'B'], // agent 开始改之前:人那一轮,最后改的是 B
      ['bot4', 'bot'], // agent 改完了(人又动手):agent 那一轮
    ]) // 人这一轮还没结束:'after2' 就是文件现在的样子
  })

  it('换了另一个 agent 也切;任何人停够 30 s 再改也切(同一个人也一样)', async () => {
    const h = harness()
    h.write(BOT, 'b1'); h.tick(100)
    h.write(BOT2, 'c1'); h.tick(30_000)
    h.write(BOT2, 'c2'); h.tick(29_999)
    h.write(A, 'a1'); h.tick(29_999)
    h.write(B, 'ab')
    await h.settled()
    expect(h.recorded).toEqual([['v0', null], ['b1', 'bot'], ['c1', 'bot2'], ['c2', 'bot2']])
  })

  it('不等写库:before 同步返回,记下的是那一刻的正文;写失败只报出去,后面照记', async () => {
    const h = harness()
    h.failOn('v0')
    h.write(A, 'A1')
    h.write(BOT, 'B1') // 排在失败那一版后面
    expect(h.recorded).toEqual([]) // 还没写:before 不等
    await h.settled()
    expect(h.errors).toHaveLength(1)
    expect(h.recorded).toEqual([['A1', 'A']])
  })

  it('可能换轮时才问 changes();不改内容就既不记、也不换轮', async () => {
    const h = harness()
    let asked = 0
    h.write(A, 'A1')
    h.write(B, 'A1', () => (asked++, true)) // 人换人:不问,同一轮
    expect(asked).toBe(0)
    h.write(BOT, 'A1', () => (asked++, false)) // agent 只是打开了文件
    expect(asked).toBe(1)
    h.write(A, 'A2') // 还是人那一轮
    await h.settled()
    expect(h.recorded).toEqual([['v0', null]])
  })

  it('停够 idleMs 的轮拿出内存:下一笔改动(哪个文件都行)进来时当场记成一版,作者对得上;Map 降回去;这个文件再改,库里不多记', async () => {
    let clock = 0
    const texts = new Map([['x', 'x0'], ['y', 'y0'], ['z', 'z0']])
    // 假的库:和 chat.files_record_version 一样,与这个文件最近一版相同就不记
    const history = new Map<string, [string, string | null][]>()
    const rounds = createRounds({
      idleMs: 30_000,
      now: () => clock,
      record: async (itemId: string, t: string, by: string | null) => {
        const list = history.get(itemId) ?? []
        if (list.at(-1)?.[0] !== t) list.push([t, by])
        history.set(itemId, list)
      },
      read: async (itemId: string) => texts.get(itemId) ?? null,
    })
    const write = (itemId: string, writer: { id: string; agent: boolean }, next: string) => {
      rounds.before(itemId, writer, () => texts.get(itemId)!)
      texts.set(itemId, next)
    }
    const settled = () => Promise.all(['x', 'y', 'z'].map((id) => rounds.settled(id)))

    write('x', BOT, 'x-bot')
    expect(rounds.size()).toBe(1)
    clock += 30_000 // agent 停够了:它那一轮已经结束
    write('y', A, 'y-A') // 别的文件来了一笔:x 那一轮拿出内存,当场记成一版,作者是 agent
    expect(rounds.size()).toBe(1)
    await settled()
    expect(history.get('x')).toEqual([['x0', null], ['x-bot', 'bot']])

    clock += 1_000
    write('x', B, 'x-B') // B 再写 x:x 已经不在内存里,走「第一笔」那条路;正文和刚记的那版相同,库里不再记
    expect(rounds.size()).toBe(2)
    await settled()
    expect(history.get('x')).toEqual([['x0', null], ['x-bot', 'bot']])

    clock += 30_000 // x、y 都停够了
    write('z', A, 'z-A')
    expect(rounds.size()).toBe(1) // 只剩 z
    await settled()
    expect(history.get('x')).toEqual([['x0', null], ['x-bot', 'bot'], ['x-B', 'B']])
    expect(history.get('y')).toEqual([['y0', null], ['y-A', 'A']])

    texts.delete('z') // 文件没了:read 回 null,不记
    clock += 30_000
    write('y', A, 'y-A2')
    await settled()
    expect(history.get('z')).toEqual([['z0', null]])
    expect(rounds.size()).toBe(1)
  })

  it('停服时 flush:内存里的每一轮当场记下,作者照旧;内存清空;写完才返回', async () => {
    const texts = new Map([['x', 'x0'], ['y', 'y0']])
    const recorded: [string, string, string | null][] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const rounds = createRounds({
      idleMs: 30_000,
      now: () => 0,
      record: async (itemId: string, t: string, by: string | null) => {
        await gate // 写库还没回来:flush 要等它
        recorded.push([itemId, t, by])
      },
      read: (itemId: string) => texts.get(itemId) ?? null,
    })
    rounds.before('x', BOT, () => texts.get('x')!)
    texts.set('x', 'x-bot')
    rounds.before('y', A, () => texts.get('y')!)
    texts.set('y', 'y-A')
    let done = false
    const flushed = rounds.flush().then(() => (done = true))
    expect(rounds.size()).toBe(0)
    await Promise.resolve()
    expect(done).toBe(false) // 还在等写库
    release()
    await flushed
    expect(recorded.filter(([id]) => id === 'x')).toEqual([['x', 'x0', null], ['x', 'x-bot', 'bot']])
    expect(recorded.filter(([id]) => id === 'y')).toEqual([['y', 'y0', null], ['y', 'y-A', 'A']])
  })
})
