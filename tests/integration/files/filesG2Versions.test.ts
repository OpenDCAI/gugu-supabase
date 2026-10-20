import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Fixture, editFile, filesConfig, getFile, machine, openPage, sleep, startFiles, startIssuer, waitFor, type Issuer, type Running } from './support.ts'

/**
 * G2(迁移 20261011011100 + services/files/src/rounds.mjs):文本文件每一轮改动留一版,人手改和 agent 改在同一条历史里。
 * 这里测的是 agent 那一轮的边界(agent 开始改、改完了):人的 WS 改动与 agent 的 HTTP edit(as-agent)交替;卸载不切
 * (agent 每次 HTTP edit 后文件都会卸载,一轮里几笔都是一轮);还没结束的那一轮就是文件现在的样子,不进历史。
 * 「停够 30 s」与「人换人不切」用注入的时钟在 tests/unit/files/rounds.test.ts 里测;这里 roundIdleMs 配成 10 分钟,
 * 不让测试机的快慢决定版数。写库排队、不等,所以读历史用 waitFor 等它写完,不断言时间。
 * 对照(今天的库):workspace_item_versions 不存在,文本文件没有任何历史。
 */
let fx: Fixture
let issuer: Issuer
let svc: Running
const u = { a: '', b: '', agent: '' }
let chat: string

beforeAll(async () => {
  fx = new Fixture()
  await fx.connect()
  issuer = await startIssuer()
  svc = await startFiles(filesConfig(await fx.filesLogin(), issuer.jwksUrl, { debounceMs: 100, maxDebounceMs: 300, roundIdleMs: 600_000 }))
  u.a = await fx.person('G2 A')
  u.b = await fx.person('G2 B')
  u.agent = await fx.agentOf(u.b, 'G2 Agent')
  chat = await fx.group(u.b, [u.a, u.agent])
})
afterAll(async () => {
  await svc?.close()
  await issuer?.close()
  await fx?.cleanup()
})

async function versions(itemId: string) {
  const { rows } = await fx.admin.query<{ n: number; inline_text: string; made_by: string | null }>(
    'SELECT n, inline_text, made_by FROM chat.workspace_item_versions WHERE item_id = $1 ORDER BY n',
    [itemId],
  )
  return rows
}

describe('G2 一轮一版', () => {
  it('B 建的文件:A 改一轮、agent 改一轮、A 再改一轮、关掉 —— agent 那一轮前后各一版,作者对得上;关掉不多记', async () => {
    const file = await fx.file(chat, u.b, '计划.md', 'text/markdown', '初稿')
    const ta = await issuer.mint(u.a)
    const tb = await issuer.mint(u.b)
    const A = machine(svc.url, ta)
    const pa = openPage(A, file, 0)
    await pa.synced
    const live = async () => (await getFile(svc.url, tb, file)).body.text as string

    const text = pa.doc.getText('content')
    text.insert(text.length, '·A1')
    await sleep(50)
    text.insert(text.length, '·A2')
    expect(await waitFor(async () => (await live()) === '初稿·A1·A2', 3000)).toBeGreaterThanOrEqual(0)

    expect((await editFile(svc.url, tb, file, '初稿', '定稿', u.agent)).status).toBe(200)
    expect(await waitFor(() => text.toString() === '定稿·A1·A2', 3000)).toBeGreaterThanOrEqual(0)

    text.insert(text.length, '·A3')
    expect(await waitFor(async () => (await live()) === '定稿·A1·A2·A3', 3000)).toBeGreaterThanOrEqual(0)

    pa.close()
    expect(await waitFor(() => !svc.service.hocuspocus.documents.has(`${file}@0`), 5000)).toBeGreaterThanOrEqual(0)
    A.socket.destroy()

    expect(await waitFor(async () => (await versions(file)).length === 3, 5000)).toBeGreaterThanOrEqual(0)
    expect(await versions(file)).toEqual([
      { n: 1, inline_text: '初稿', made_by: u.b }, // A 第一笔之前:建好以后没变过 ⇒ 建它的人
      { n: 2, inline_text: '初稿·A1·A2', made_by: u.a }, // agent 开始改之前:人那一轮
      { n: 3, inline_text: '定稿·A1·A2', made_by: u.agent }, // agent 改完了(A 又动手):agent 那一轮
    ]) // A 的最后一轮 '定稿·A1·A2·A3' 是文件现在的样子,卸载不记它
    expect(svc.service.stats.versions).toMatchObject({ recorded: 3, errors: 0 })
  })

  it('打开不改、关掉:不多一版;同一轮里写了又删回去:关掉时与上一版相同,不记', async () => {
    const file = await fx.file(chat, u.b, '不变.md', 'text/markdown', '原样')
    const ta = await issuer.mint(u.a)
    const A = machine(svc.url, ta)
    const p1 = openPage(A, file, 0)
    await p1.synced
    p1.close()
    expect(await waitFor(() => !svc.service.hocuspocus.documents.has(`${file}@0`), 5000)).toBeGreaterThanOrEqual(0)
    expect(await versions(file)).toEqual([])

    const p2 = openPage(A, file, 0)
    await p2.synced
    const text = p2.doc.getText('content')
    text.insert(0, 'x')
    await sleep(100)
    text.delete(0, 1)
    await sleep(300)
    p2.close()
    expect(await waitFor(() => !svc.service.hocuspocus.documents.has(`${file}@0`), 5000)).toBeGreaterThanOrEqual(0)
    A.socket.destroy()
    // 第一笔之前记了「原样」;关掉时还是「原样」,与它相同,不再记
    expect(await waitFor(async () => (await versions(file)).length >= 1, 5000)).toBeGreaterThanOrEqual(0)
    expect(svc.service.stats.versions.errors).toBe(0)
    expect(await versions(file)).toEqual([{ n: 1, inline_text: '原样', made_by: u.b }])
  })

  it('agent 一轮里连着两次 HTTP edit,两次之间文件卸载了:还是一轮;人再改时记一版,作者是 agent', async () => {
    const file = await fx.file(chat, u.b, '连改.md', 'text/markdown', '原稿')
    const tb = await issuer.mint(u.b)
    const unloaded = () => waitFor(() => !svc.service.hocuspocus.documents.has(`${file}@0`), 5000)
    expect((await editFile(svc.url, tb, file, '原稿', '一改', u.agent)).status).toBe(200)
    expect(await unloaded()).toBeGreaterThanOrEqual(0)
    expect((await editFile(svc.url, tb, file, '一改', '二改', u.agent)).status).toBe(200)
    expect(await unloaded()).toBeGreaterThanOrEqual(0)

    const A = machine(svc.url, await issuer.mint(u.a))
    const pa = openPage(A, file, 0)
    await pa.synced
    const text = pa.doc.getText('content')
    text.insert(text.length, '·人')
    expect(await waitFor(async () => (await versions(file)).length === 2, 5000)).toBeGreaterThanOrEqual(0)
    pa.close()
    expect(await unloaded()).toBeGreaterThanOrEqual(0)
    A.socket.destroy()
    expect(svc.service.stats.versions.errors).toBe(0)
    expect(await versions(file)).toEqual([
      { n: 1, inline_text: '原稿', made_by: u.b }, // agent 第一笔之前
      { n: 2, inline_text: '二改', made_by: u.agent }, // agent 那一轮(两笔)改完的样子
    ])
  })
})

describe('存盘先等这个文件排着的历史写完(CI 上撞到的先后),等不到也照存', () => {
  /** 一个连接池:files_record_version 的调用等 hold() 放行,别的照常。 */
  function historyHeld(dbUrl: string, hold: () => Promise<void>) {
    const pool = new pg.Pool({ connectionString: dbUrl, max: 4 })
    const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>
    const held = new Proxy(pool, {
      get: (target, key) =>
        key === 'query'
          ? (sql: unknown, ...rest: unknown[]) => (typeof sql === 'string' && sql.includes('files_record_version') ? hold().then(() => query(sql, ...rest)) : query(sql, ...rest))
          : Reflect.get(target, key),
    })
    return { pool, held }
  }
  const inlineText = async (itemId: string) =>
    (await fx.admin.query<{ inline_text: string }>('SELECT inline_text FROM chat.workspace_items WHERE id = $1', [itemId])).rows[0]!.inline_text

  it('历史写得慢:agent 第一笔之前那一版照样记成建文件的人(存盘没抢到它前面,updated_at 还没变)', async () => {
    const config = filesConfig(await fx.filesLogin(), issuer.jwksUrl, { debounceMs: 100, maxDebounceMs: 300, roundIdleMs: 600_000, storeWaitsHistoryMs: 10_000 })
    const { pool, held } = historyHeld(config.dbUrl, async () => { await sleep(800) })
    const slow = await startFiles(config, { pool: held as unknown as pg.Pool })
    try {
      const file = await fx.file(chat, u.b, '慢历史.md', 'text/markdown', '原稿')
      expect((await editFile(slow.url, await issuer.mint(u.b), file, '原稿', '一改', u.agent)).status).toBe(200)
      expect(await waitFor(async () => (await versions(file)).length === 1 && (await inlineText(file)) === '一改', 10_000)).toBeGreaterThanOrEqual(0)
      expect(await versions(file)).toEqual([{ n: 1, inline_text: '原稿', made_by: u.b }])
      expect(slow.service.stats.versions.storeWaitTimeouts).toBe(0)
    } finally {
      await slow.close()
      await pool.end()
    }
  })

  it('历史一直写不进去(库函数不返回):存盘照样完成,只记一次超时;停服也不挂住', async () => {
    const config = filesConfig(await fx.filesLogin(), issuer.jwksUrl, { debounceMs: 100, maxDebounceMs: 300, roundIdleMs: 600_000, storeWaitsHistoryMs: 300 })
    const { pool, held } = historyHeld(config.dbUrl, () => new Promise<void>(() => {}))
    const stuck = await startFiles(config, { pool: held as unknown as pg.Pool })
    try {
      const file = await fx.file(chat, u.b, '卡住的历史.md', 'text/markdown', '原稿')
      expect((await editFile(stuck.url, await issuer.mint(u.b), file, '原稿', '一改', u.agent)).status).toBe(200)
      expect(await waitFor(async () => (await inlineText(file)) === '一改', 10_000)).toBeGreaterThanOrEqual(0)
      expect(stuck.service.stats.versions.storeWaitTimeouts).toBeGreaterThanOrEqual(1)
      expect(stuck.logs.some((line) => String(line.msg).startsWith('history: still being written after 300 ms; storing anyway'))).toBe(true)
      expect(await versions(file)).toEqual([])
    } finally {
      await stuck.close()
      await pool.end()
    }
  })
})
