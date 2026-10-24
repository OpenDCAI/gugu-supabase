import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { colorFor } from '../../../packages/files-core/src/presence.mjs'
import {
  Fixture,
  SEED,
  SUBPROTOCOL,
  Typist,
  editFile,
  getFile,
  machine,
  openPage,
  filesConfig,
  sleep,
  startIssuer,
  startFiles,
  stats,
  typeString,
  waitFor,
  type Issuer,
  type Machine,
  type Page,
  type Running,
} from './support.ts'

/**
 * E5(原型 e5-auth-json 的本仓版):谁能进、HTTP 契约(真源 §2.2)、移出与删除、JSON 合并、presence 盖章、上限与限速、加载核对。
 * 每条否定配正对照。服务跑在测试进程里;上限调小到 64 KB 让用例快。
 */
const LIMIT = 64 * 1024
let fx: Fixture
let issuer: Issuer
let svc: Running
let dbUrl: string
const u = { a: '', b: '', c: '', owner: '', agent: '', outsider: '', strangerAgentOwner: '', strangerAgent: '' }
let chat: string
let agentChat: string
let doc: string
let board: string
let binary: string
let agentDoc: string
let dmDoc: string
const machines: Machine[] = []
const pages: Page[] = []

describe('current resource container authorization', () => {
  it('reauthorizes open connections after a metadata move and preserves the same live document', async () => {
    const oldRoom = await fx.group(u.a, [u.b, u.c])
    const newRoom = await fx.group(u.a, [u.c])
    const item = await fx.file(oldRoom, u.a, 'moved.md', 'text/markdown', 'seed\n')
    const removed = page(track(machine(svc.url, await issuer.mint(u.b))), item)
    const kept = page(track(machine(svc.url, await issuer.mint(u.c))), item)
    await Promise.all([removed.synced, kept.synced])
    removed.doc.getText('content').insert(0, 'before:')
    expect(await waitFor(async () => (await fx.row(item)).inline_text?.startsWith('before:') === true)).toBeGreaterThanOrEqual(0)
    await fx.admin.query('UPDATE chat.workspace_items SET chat_id=$1 WHERE id=$2', [newRoom, item])
    await fx.admin.query("SELECT pg_notify('files_member_removed','')")
    expect(await waitFor(() => removed.events.closed?.reason === 'removed-from-group')).toBeGreaterThanOrEqual(0)
    expect(await waitFor(() => [...svc.service.hocuspocus.documents.values()].some((d) =>
      [...d.getConnections()].some((c) => c.context?.actorId === u.c && c.context?.itemId === item && c.context?.chatId === newRoom)))).toBeGreaterThanOrEqual(0)
    expect((await getFile(svc.url, await issuer.mint(u.b), item)).status).toBe(404)
    expect((await getFile(svc.url, await issuer.mint(u.c), item)).status).toBe(200)
    // Removal from the old container must not kill a connection now authorized
    // by the new one; a real edit must still reach the same persisted document.
    await fx.remove(oldRoom, u.c)
    kept.doc.getText('content').insert(0, 'after:')
    expect(await waitFor(async () => (await fx.row(item)).inline_text?.startsWith('after:before:') === true)).toBeGreaterThanOrEqual(0)
    expect((await fx.row(item)).epoch).toBe(0)
    expect(kept.events.closed).toBeNull()
  })

  it('leaving a topic does not revoke source access; leaving the source does', async () => {
    const root = await fx.group(u.a, [u.b])
    const topicId = crypto.randomUUID(), anchor = crypto.randomUUID()
    await fx.admin.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'anchor')`, [anchor, root, u.a])
    await fx.admin.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id,source_message_id)
      VALUES ($1,'topic','participation fixture',$2,$3,$4)`, [topicId, u.a, root, anchor])
    await fx.admin.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')`, [topicId, u.a, u.b])
    const item = await fx.file(root, u.a, 'shared.md', 'text/markdown', 'seed\n')
    const p = page(track(machine(svc.url, await issuer.mint(u.b))), item)
    await p.synced
    await fx.remove(topicId, u.b)
    p.doc.getText('content').insert(0, 'still:')
    expect(await waitFor(async () => (await fx.row(item)).inline_text?.startsWith('still:') === true)).toBeGreaterThanOrEqual(0)
    expect((await getFile(svc.url, await issuer.mint(u.b), item)).status).toBe(200)
    await fx.remove(root, u.b)
    expect(await waitFor(() => p.events.closed?.reason === 'removed-from-group')).toBeGreaterThanOrEqual(0)
    expect((await getFile(svc.url, await issuer.mint(u.b), item)).status).toBe(404)
  })
})

function track(m: Machine) {
  machines.push(m)
  return m
}
function page(m: Machine, itemId: string, epoch = 0) {
  const p = openPage(m, itemId, epoch)
  pages.push(p)
  return p
}
/** 同一份 JSON(Y.Map 各副本的键序可以不同,按值比)。 */
function sameJson(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as any)[k])])) : v
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b))
}
async function settled(p: Page, ms = 3000) {
  await waitFor(() => !!p.events.authFailed || !!p.events.synced || !!p.events.closed, ms)
  return p.events.authFailed ? `rejected: ${p.events.authFailed.reason}` : p.events.synced ? 'synced' : 'no-sync'
}

beforeAll(async () => {
  fx = new Fixture()
  await fx.connect()
  issuer = await startIssuer()
  dbUrl = await fx.filesLogin()
  svc = await startFiles(filesConfig(dbUrl, issuer.jwksUrl, { maxFileBytes: LIMIT }))
  u.a = await fx.person('E5 A')
  u.b = await fx.person('E5 B')
  u.c = await fx.person('E5 C')
  u.outsider = await fx.person('E5 Outsider')
  u.owner = await fx.person('E5 Owner')
  u.agent = await fx.agentOf(u.owner, 'E5 Agent')
  u.strangerAgentOwner = await fx.person('E5 Stranger')
  u.strangerAgent = await fx.agentOf(u.strangerAgentOwner, 'E5 Stranger Agent')
  chat = await fx.group(u.a, [u.b, u.c])
  doc = await fx.file(chat, u.a, '协同测试.md', 'text/markdown', SEED)
  board = await fx.file(chat, u.a, '一桌.snake', 'application/json', JSON.stringify({ food: [3, 4], scores: {} }))
  binary = await fx.file(chat, u.a, 'photo.png', 'image/png', null, 'file')
  // agent 在、它的主人不在的群
  agentChat = await fx.group(u.a, [u.b, u.agent])
  agentDoc = await fx.file(agentChat, u.a, 'agent.md', 'text/markdown', 'agent 的文件\n')
  const dm = await fx.group(u.a, [u.b], 'dm')
  dmDoc = await fx.file(dm, u.a, 'dm.md', 'text/markdown', 'dm\n')
})
afterAll(async () => {
  for (const p of pages) p.close()
  for (const m of machines) m.socket.destroy()
  await svc?.close()
  await issuer?.close()
  await fx?.cleanup()
})

describe('WebSocket:凭证走子协议,判权走 files_authorize', () => {
  it('子协议:服务端选中 gugu-files.v1;不带它、或令牌放在 query 里,握手直接被拒', async () => {
    const ws = svc.url.replace(/^http/, 'ws') + '/'
    const token = await issuer.mint(u.a)
    const open = (url: string, protocols: string[]) =>
      new Promise<string>((resolve) => {
        const s = new WebSocket(url, protocols)
        s.addEventListener('open', () => {
          resolve(`open:${s.protocol}`)
          s.close()
        })
        s.addEventListener('error', () => resolve('error'))
      })
    expect(await open(ws, [SUBPROTOCOL, `bearer.${token}`])).toBe(`open:${SUBPROTOCOL}`)
    expect(await open(ws, [`bearer.${token}`])).toBe('error')
    expect(await open(`${ws}?token=${token}`, [SUBPROTOCOL])).toBe('error')
    expect(await open(ws.replace(/\/$/, '/elsewhere'), [SUBPROTOCOL, `bearer.${token}`])).toBe('error')
  })

  it('成员进得去;不是成员、乱写的令牌、别的钥匙签的令牌、过期令牌都进不去', async () => {
    const tries = {
      member: await issuer.mint(u.b),
      outsider: await issuer.mint(u.outsider),
      garbage: 'not-a-jwt',
      forged: await issuer.mint(u.a, { foreign: true }),
      expired: await issuer.mint(u.a, { expiresIn: Math.floor(Date.now() / 1000) - 60 }),
    }
    const result: Record<string, string> = {}
    for (const [k, jwt] of Object.entries(tries)) result[k] = await settled(page(track(machine(svc.url, jwt)), doc))
    expect(result).toEqual({
      member: 'synced',
      outsider: 'rejected: not-found',
      garbage: 'no-sync',
      forged: 'no-sync',
      expired: 'no-sync',
    })
    // 握手就被拒的三个,在服务端记成 bad-credential。
    expect((await stats(svc.adminUrl)).rejects['bad-credential']).toBeGreaterThanOrEqual(3)
  })

  // 20261005114650(主人 10-05「私聊也是得有面板的」):私聊里的文件和群里的一样,成员能开,外人与不存在同一个拒绝原因。
  it('不存在、二进制文件、代号不对:各自的拒绝原因;私聊里的文件成员能开、外人不能', async () => {
    const m = track(machine(svc.url, await issuer.mint(u.a)))
    expect(await settled(page(m, '00000000-0000-4000-8000-000000000000'))).toBe('rejected: not-found')
    expect(await settled(page(m, binary))).toBe('rejected: not-a-document')
    expect(await settled(page(m, dmDoc))).toBe('synced')
    const outsider = track(machine(svc.url, await issuer.mint(u.outsider)))
    expect(await settled(page(outsider, dmDoc))).toBe('rejected: not-found')
    expect(await settled(page(m, doc, 7))).toBe('rejected: stale-epoch:0')
    expect(await settled(page(m, doc, 0))).toBe('synced') // 正对照:同一台机器、同一个人
  })
})

describe('HTTP 契约(§2.2)', () => {
  it('读:要令牌;成员 200,不是成员与不存在都 404 not-found,二进制 409 not-a-document', async () => {
    expect(await getFile(svc.url, null, doc)).toEqual({ status: 401, body: { error: 'bad-credential' } })
    expect(await getFile(svc.url, await issuer.mint(u.outsider), doc)).toEqual({ status: 404, body: { error: 'not-found' } })
    expect(await getFile(svc.url, await issuer.mint(u.a), '00000000-0000-4000-8000-000000000000')).toEqual({
      status: 404,
      body: { error: 'not-found' },
    })
    expect(await getFile(svc.url, await issuer.mint(u.a), binary)).toEqual({ status: 409, body: { error: 'not-a-document' } })
    const ok = await getFile(svc.url, await issuer.mint(u.c), doc)
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ epoch: 0, contentType: 'text/markdown' })
  })

  it('agent:X-Gugu-As-Agent 按 agent 自己是不是成员判;别人的 agent、陌生人拿主人的 agent 都 404', async () => {
    const owner = await issuer.mint(u.owner)
    expect(await getFile(svc.url, owner, agentDoc)).toEqual({ status: 404, body: { error: 'not-found' } }) // 主人不在群里
    expect((await getFile(svc.url, owner, agentDoc, u.agent)).status).toBe(200) // agent 在
    expect((await getFile(svc.url, owner, doc, u.agent)).status).toBe(404) // agent 不在这个群
    expect((await getFile(svc.url, owner, agentDoc, u.strangerAgent)).status).toBe(404)
    expect((await getFile(svc.url, await issuer.mint(u.b), agentDoc, u.agent)).status).toBe(404) // b 在群里,但 agent 不是 b 的
    expect((await editFile(svc.url, owner, agentDoc, 'agent 的文件', 'agent 改过的文件', u.agent)).status).toBe(200)
    expect((await getFile(svc.url, owner, agentDoc, u.agent)).body.text).toBe('agent 改过的文件\n')
  })

  it('agent 走 WebSocket:子协议 as.<agentId>,判据和 HTTP 一样;打开以后这条连接的章、self、被移出群都按 agent 算', async () => {
    const owner = await issuer.mint(u.owner)
    const asAgent = (jwt: string, ...extra: string[]) => track(machine(svc.url, jwt, { protocols: [SUBPROTOCOL, `bearer.${jwt}`, ...extra] }))
    // 对照:主人不在这个群,不带 as. 进不去
    expect(await settled(page(asAgent(owner), agentDoc))).toBe('rejected: not-found')
    // 带上自己的 agent(它是群成员)就进得去
    const room = await fx.group(u.a, [u.b, u.agent])
    const file = await fx.file(room, u.a, 'as-agent.md', 'text/markdown', 'hi\n')
    const pa = page(asAgent(owner, `as.${u.agent}`), file)
    const selves: any[] = []
    pa.provider.on('stateless', ({ payload }: { payload: string }) => selves.push(JSON.parse(payload)))
    const pb = page(track(machine(svc.url, await issuer.mint(u.b))), file)
    await Promise.all([pa.synced, pb.synced])
    expect(await waitFor(() => selves.length === 1, 3000)).toBeGreaterThanOrEqual(0)
    expect(selves[0].user).toMatchObject({ id: u.agent, name: 'E5 Agent' })
    pa.provider.awareness!.setLocalState({ cursor: 1 })
    expect(await waitFor(() => pb.provider.awareness!.getStates().get(pa.doc.clientID)?.cursor === 1, 3000)).toBeGreaterThanOrEqual(0)
    expect(pb.provider.awareness!.getStates().get(pa.doc.clientID)!.user).toEqual(selves[0].user)
    pa.doc.getText('content').insert(0, 'agent:')
    expect(await waitFor(() => pb.text().startsWith('agent:'), 3000)).toBeGreaterThanOrEqual(0)
    // 否定:agent 不在的群、别人的 agent、不是自己的 agent、两个身份、空的,一律 not-found
    const tb = await issuer.mint(u.b)
    const denied = {
      agentNotInThatGroup: await settled(page(asAgent(owner, `as.${u.agent}`), doc)),
      someoneElsesAgent: await settled(page(asAgent(owner, `as.${u.strangerAgent}`), file)),
      notYourAgent: await settled(page(asAgent(tb, `as.${u.agent}`), file)),
      twoIdentities: await settled(page(asAgent(owner, `as.${u.agent}`, `as.${u.strangerAgent}`), file)), // 同一项重复在客户端就被 WebSocket 拒了,送得到服务端的是两个不同的
      empty: await settled(page(asAgent(owner, 'as.'), file)),
    }
    expect(denied).toEqual({
      agentNotInThatGroup: 'rejected: not-found',
      someoneElsesAgent: 'rejected: not-found',
      notYourAgent: 'rejected: not-found',
      twoIdentities: 'rejected: not-found',
      empty: 'rejected: not-found',
    })
    // 把 agent 移出群:断开的是代它打开的那条连接,人的连接照常
    await fx.remove(room, u.agent)
    expect(await waitFor(() => pa.events.closed?.reason === 'removed-from-group', 5000)).toBeGreaterThanOrEqual(0)
    expect(pb.events.closed).toBeNull()
  })

  it('改:不是成员与不存在都 404 not-found,一字不差;成员 200', async () => {
    const file = await fx.file(chat, u.a, 'e5-edit.md', 'text/markdown', 'one line\n')
    const outsider = await issuer.mint(u.outsider)
    const notMember = await editFile(svc.url, outsider, file, 'one', 'two')
    expect(notMember).toEqual({ status: 404, body: { error: 'not-found' } })
    expect(await editFile(svc.url, outsider, '00000000-0000-4000-8000-000000000000', 'one', 'two')).toEqual(notMember)
    expect((await getFile(svc.url, await issuer.mint(u.a), file)).body.text).toBe('one line\n')
    // 正对照:成员改同一处,200。
    expect((await editFile(svc.url, await issuer.mint(u.a), file, 'one', 'two')).status).toBe(200)
  })

  it('改:空 old 400,缺字段 400,找不到 409 content-changed,多处 409 ambiguous,超限 413,二进制 409', async () => {
    const t = await issuer.mint(u.a)
    expect(await editFile(svc.url, t, doc, '', 'x')).toEqual({ status: 400, body: { error: 'empty-old' } })
    const missing = await fetch(`${svc.url}/${doc}/edit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ old: 'x' }),
    })
    expect(missing.status).toBe(400)
    expect((await editFile(svc.url, t, doc, '这句话不存在', 'x')).body).toMatchObject({ error: 'content-changed' })
    expect((await editFile(svc.url, t, doc, '在这段后面写', 'x')).body).toMatchObject({ error: 'ambiguous', count: 3 })
    expect(await editFile(svc.url, t, doc, '第一句', 'x'.repeat(LIMIT))).toMatchObject({ status: 413, body: { error: 'too-large' } })
    expect(await editFile(svc.url, t, binary, 'a', 'b')).toEqual({ status: 409, body: { error: 'not-a-document' } })
    // 正对照:以上都没动到文件。
    expect((await getFile(svc.url, t, doc)).body.text).toBe(SEED)
  })

  it('对外口只有 /:id、/:id/edit 与 WebSocket;/stats、/healthz 只在内部口(对外口上不验令牌直接 404)', async () => {
    expect((await fetch(`${svc.url}/stats`)).status).toBe(404)
    expect((await fetch(`${svc.url}/healthz`)).status).toBe(404)
    expect((await fetch(`${svc.url}/${doc}`, { method: 'DELETE' })).status).toBe(405)
    expect((await fetch(`${svc.adminUrl}/healthz`)).status).toBe(200)
    expect((await fetch(`${svc.adminUrl}/stats`)).status).toBe(200)
  })
})

describe('移出群与删除文件', () => {
  it('开着文件时被移出群 ⇒ 立刻断开,之后打的字不外泄;没被移出的人照常', async () => {
    const group = await fx.group(u.a, [u.b, u.c])
    const file = await fx.file(group, u.a, 'kick.md', 'text/markdown', SEED)
    const pa = page(track(machine(svc.url, await issuer.mint(u.a))), file)
    const pb = page(track(machine(svc.url, await issuer.mint(u.b))), file)
    const pc = page(track(machine(svc.url, await issuer.mint(u.c))), file)
    await Promise.all([pa.synced, pb.synced, pc.synced])
    const before = (await stats(svc.adminUrl)).kicks.removed
    const t0 = Date.now()
    await fx.remove(group, u.b)
    expect(await waitFor(async () => (await stats(svc.adminUrl)).kicks.removed > before, 3000, 5)).toBeGreaterThanOrEqual(0)
    const cutMs = Date.now() - t0
    await typeString(new Typist(pb, '（B 在这段后面写）'), '‹AFTER-REMOVAL›', 50)
    await typeString(new Typist(pc, '（C 在这段后面写）'), '‹C-STILL-HERE›', 50)
    expect(await waitFor(() => pa.text().includes('‹C-STILL-HERE›'), 3000)).toBeGreaterThanOrEqual(0)
    await sleep(500)
    expect(pa.text()).not.toContain('‹AFTER-REMOVAL›')
    expect((await getFile(svc.url, await issuer.mint(u.a), file)).body.text).not.toContain('‹AFTER-REMOVAL›')
    expect(cutMs).toBeLessThan(3000)
    expect(pb.events.closed?.reason).toBe('removed-from-group')
    expect(pc.events.closed).toBeNull()
  })

  it('开着文件时文件被删 ⇒ 连接断开、卸载、不再存盘;同群别的文件不受影响', async () => {
    const group = await fx.group(u.a, [u.b])
    const doomed = await fx.file(group, u.a, 'doomed.md', 'text/markdown', 'doomed\n')
    const kept = await fx.file(group, u.a, 'kept.md', 'text/markdown', 'kept\n')
    const m = track(machine(svc.url, await issuer.mint(u.a)))
    const pd = page(m, doomed)
    const pk = page(m, kept)
    await Promise.all([pd.synced, pk.synced])
    await typeString(new Typist(pd, 'doomed'), '!', 50)
    const s0 = await stats(svc.adminUrl)
    await fx.admin.query('DELETE FROM chat.workspace_items WHERE id = $1', [doomed])
    expect(await waitFor(async () => (await stats(svc.adminUrl)).kicks.deleted > s0.kicks.deleted, 3000, 5)).toBeGreaterThanOrEqual(0)
    await typeString(new Typist(pk, 'kept'), '!', 50)
    expect(await waitFor(async () => (await getFile(svc.url, await issuer.mint(u.b), kept)).body.text === 'kept!\n', 3000)).toBeGreaterThanOrEqual(0)
    const s1 = await stats(svc.adminUrl)
    expect(s1.storeLost).toBe(s0.storeLost)
    expect(s1.storeErrors).toBe(s0.storeErrors)
    expect(await fx.row(doomed)).toBeUndefined()
    expect(pd.events.closed?.reason).toBe('deleted') // ❌ 鉴权的 not-found:页面要据此变成 gone
    expect(pk.events.closed).toBeNull()
  })
})

describe('JSON 文件(App 的数据)', () => {
  it('不同的键都保留,同一个键后写者胜;agent 按文本改 JSON,页面立刻看到;改坏了 422 且文档不动', async () => {
    const pa = page(track(machine(svc.url, await issuer.mint(u.a))), board)
    const pb = page(track(machine(svc.url, await issuer.mint(u.b))), board)
    await Promise.all([pa.synced, pb.synced])
    const ra = pa.doc.getMap<any>('root')
    const rb = pb.doc.getMap<any>('root')
    const last: Record<string, number[]> = {}
    for (let i = 1; i <= 30; i++) {
      ra.get('scores').set('a', i)
      rb.get('scores').set('b', i * 10)
      const fa = new Y.Array<number>()
      fa.push([i, 1])
      ra.set('food', fa)
      const fb = new Y.Array<number>()
      fb.push([1, i])
      rb.set('food', fb)
      last.a = [i, 1]
      last.b = [1, i]
      await sleep(10)
    }
    expect(await waitFor(() => sameJson(ra.toJSON(), rb.toJSON()), 3000)).toBeGreaterThanOrEqual(0)
    const merged = ra.toJSON()
    expect(merged.scores).toEqual({ a: 30, b: 300 })
    expect([JSON.stringify(last.a), JSON.stringify(last.b)]).toContain(JSON.stringify(merged.food))
    expect(sameJson(merged.food, last.a) || sameJson(merged.food, last.b)).toBe(true)

    const t = await issuer.mint(u.c)
    const pretty = (await getFile(svc.url, t, board)).body.text as string
    expect(JSON.parse(pretty)).toEqual(merged)
    expect(pretty).toBe(JSON.stringify(JSON.parse(pretty), null, 2)) // 缩进 2 格
    const at = pretty.indexOf('"food"')
    const foodBlock = pretty.slice(at, pretty.indexOf(']', at) + 1)
    expect((await editFile(svc.url, t, board, foodBlock, '"food": [7, 7],\n  "round": 2')).status).toBe(200)
    expect(await waitFor(() => ra.get('round') === 2 && rb.get('round') === 2, 3000)).toBeGreaterThanOrEqual(0)
    expect(ra.get('food').toJSON()).toEqual([7, 7])
    expect(await editFile(svc.url, t, board, '"round": 2', '"round": 2,,')).toMatchObject({ status: 422, body: { error: 'invalid-json' } })
    expect(ra.get('round')).toBe(2)

    pa.close()
    pb.close()
    expect(await waitFor(async () => !svc.service.hocuspocus.documents.has(`${board}@0`), 8000)).toBeGreaterThanOrEqual(0)
    const row = await fx.row(board)
    expect(JSON.parse(row!.inline_text!)).toEqual(ra.toJSON())
    expect(row!.inline_text).toBe(JSON.stringify(JSON.parse(row!.inline_text!))) // 库里是紧凑形
  })
})

describe('presence 由服务盖章', () => {
  it('页面自报的 user 被覆盖成连接身份 { id, name, color },别的字段原样;别人的 clientID 冒用不了', async () => {
    const group = await fx.group(u.a, [u.b, u.c])
    const file = await fx.file(group, u.a, 'presence.md', 'text/markdown', 'hi\n')
    const pa = page(track(machine(svc.url, await issuer.mint(u.a))), file)
    const pb = page(track(machine(svc.url, await issuer.mint(u.b))), file)
    const pc = page(track(machine(svc.url, await issuer.mint(u.c))), file)
    await Promise.all([pa.synced, pb.synced, pc.synced])
    pa.provider.awareness!.setLocalState({ user: { id: 'forged', name: 'Mallory', color: '#000000' }, cursor: 3 })
    pb.provider.awareness!.setLocalState({ cursor: 9 })
    const seenByB = () => pb.provider.awareness!.getStates().get(pa.doc.clientID)
    expect(await waitFor(() => seenByB()?.cursor === 3, 3000)).toBeGreaterThanOrEqual(0)
    expect(seenByB()).toEqual({ user: { id: u.a, name: 'E5 A', color: colorFor(u.a) }, cursor: 3 })
    const seenByA = () => pa.provider.awareness!.getStates().get(pb.doc.clientID)
    expect(await waitFor(() => seenByA()?.cursor === 9, 3000)).toBeGreaterThanOrEqual(0)
    expect(seenByA()!.user).toEqual({ id: u.b, name: 'E5 B', color: colorFor(u.b) })

    // B sends a state under A's clientID (a later clock, as a new one would have): the service drops it — C still sees
    // A's own. Control: B's own state, sent right after on the same connection, reaches C.
    const seenByC = (clientID: number) => pc.provider.awareness!.getStates().get(clientID)
    expect(await waitFor(() => seenByC(pa.doc.clientID)?.cursor === 3, 3000)).toBeGreaterThanOrEqual(0)
    const awareness = pb.provider.awareness!
    awareness.states.set(pa.doc.clientID, { cursor: 666 })
    awareness.meta.set(pa.doc.clientID, { clock: 1_000, lastUpdated: Date.now() })
    awareness.emit('update', [{ added: [pa.doc.clientID], updated: [], removed: [] }, 'forged'])
    awareness.setLocalState({ cursor: 10 })
    expect(await waitFor(() => seenByC(pb.doc.clientID)?.cursor === 10, 3000)).toBeGreaterThanOrEqual(0)
    expect(seenByC(pa.doc.clientID)).toEqual({ user: { id: u.a, name: 'E5 A', color: colorFor(u.a) }, cursor: 3 })
  })

  it('F9 self:每条文件连接认证通过后收到自己的章,和别人看到的逐字相同;重连后再发一次', async () => {
    const group = await fx.group(u.a, [u.b])
    const file = await fx.file(group, u.a, 'self.md', 'text/markdown', 'hi\n')
    const other = await fx.file(group, u.a, 'self-2.md', 'text/markdown', 'yo\n')
    const selves = (p: Page) => {
      const got: any[] = []
      p.provider.on('stateless', ({ payload }: { payload: string }) => got.push(JSON.parse(payload)))
      return got
    }
    const A = track(machine(svc.url, await issuer.mint(u.a)))
    const pa = page(A, file)
    const sa = selves(pa)
    const pa2 = page(A, other) // 同一台机器上的另一张页:各自一条
    const sa2 = selves(pa2)
    const pb = page(track(machine(svc.url, await issuer.mint(u.b))), file)
    const sb = selves(pb)
    await Promise.all([pa.synced, pa2.synced, pb.synced])
    expect(await waitFor(() => sa.length === 1 && sa2.length === 1 && sb.length === 1, 3000)).toBeGreaterThanOrEqual(0)
    expect(sa[0]).toEqual({ t: 'self', user: { id: u.a, name: 'E5 A', color: colorFor(u.a) } })
    expect(sa2[0]).toEqual(sa[0])
    expect(sb[0].user.id).toBe(u.b)

    // 读数:A 看自己的色 与 B 看 A 的色 逐字相同
    pa.provider.awareness!.setLocalState({ cursor: 1 })
    const seenByB = () => pb.provider.awareness!.getStates().get(pa.doc.clientID)
    expect(await waitFor(() => seenByB()?.cursor === 1, 3000)).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(seenByB()!.user)).toBe(JSON.stringify(sa[0].user))
    // 对照:A 自己的 awareness 里拿不到服务盖的章(本地状态的 clock 不被回声覆盖)—— self 是它唯一的来源
    await sleep(200)
    expect(pa.provider.awareness!.getLocalState()!.user).toBeUndefined()

    // 重连:重新认证 ⇒ 再发一次
    // disconnect() initiates an asynchronous close. Under CI load, 100ms can
    // elapse while the provider is still Connected, making connect() a no-op.
    const disconnected = new Promise<void>((resolve) => {
      const onDisconnect = () => {
        A.socket.off('disconnect', onDisconnect)
        resolve()
      }
      A.socket.on('disconnect', onDisconnect)
    })
    A.socket.disconnect()
    await disconnected
    await A.socket.connect()
    expect(await waitFor(() => sa.length === 2 && sa2.length === 2, 5000)).toBeGreaterThanOrEqual(0)
    expect(sa[1]).toEqual(sa[0])
    expect(sb.length).toBe(1) // B 没重连,不多发
  })
})

describe('上限与限速', () => {
  it('WebSocket 上一次塞超过上限 ⇒ 这条连接被关(too-large),内容不外泄;上限以内照常', async () => {
    const group = await fx.group(u.a, [u.b])
    const file = await fx.file(group, u.a, 'big.md', 'text/markdown', 'start\n')
    const pa = page(track(machine(svc.url, await issuer.mint(u.a))), file)
    const pb = page(track(machine(svc.url, await issuer.mint(u.b))), file)
    await Promise.all([pa.synced, pb.synced])
    pa.doc.getText('content').insert(0, 'k'.repeat(1024)) // 正对照:1 KB
    expect(await waitFor(() => pb.text().startsWith('k'.repeat(1024)), 3000)).toBeGreaterThanOrEqual(0)
    const s0 = await stats(svc.adminUrl)
    pa.doc.getText('content').insert(0, 'X'.repeat(LIMIT))
    expect(await waitFor(async () => (await stats(svc.adminUrl)).tooLarge > s0.tooLarge, 3000)).toBeGreaterThanOrEqual(0)
    await sleep(300)
    expect(pb.text()).not.toContain('XXXX')
    expect((await getFile(svc.url, await issuer.mint(u.b), file)).body.text).not.toContain('XXXX')
  })

  it('更新条数超速 ⇒ 这条连接被关(rate-limited);慢慢打字不受影响', async () => {
    const tight = await startFiles(filesConfig(dbUrl, issuer.jwksUrl, { rateUpdates: { perSecond: 5, burst: 20 } }))
    try {
      const group = await fx.group(u.a, [u.b])
      const file = await fx.file(group, u.a, 'rate.md', 'text/markdown', 'slow fast\n')
      const slow = openPage(machine(tight.url, await issuer.mint(u.b)), file, 0)
      const fast = openPage(machine(tight.url, await issuer.mint(u.a)), file, 0)
      await Promise.all([slow.synced, fast.synced])
      await typeString(new Typist(slow, 'slow'), '...', 3)
      for (let i = 0; i < 100; i++) {
        fast.doc.getText('content').insert(0, '!')
        await sleep(1)
      }
      expect(await waitFor(() => tight.service.stats.rateLimited > 0, 3000)).toBeGreaterThanOrEqual(0)
      await typeString(new Typist(slow, 'slow...'), '+', 3)
      expect(await waitFor(async () => (await getFile(tight.url, await issuer.mint(u.b), file)).body.text.includes('slow...+'), 3000)).toBeGreaterThanOrEqual(0)
      slow.close()
      fast.close()
    } finally {
      await tight.close()
    }
  })

  it('presence 超速只合并、不丢最新(F38):连发 50 帧后停住,对端最终收到的正是最后一帧,而且盖了章', async () => {
    // 突发量压到 5:50 帧里前几帧照常上,其余超速 —— 旧做法直接丢,对端停在半路。
    const tight = await startFiles(filesConfig(dbUrl, issuer.jwksUrl, { rateAwareness: { perSecond: 20, burst: 5 } }))
    try {
      const group = await fx.group(u.a, [u.b])
      const file = await fx.file(group, u.a, 'cursor.md', 'text/markdown', 'x\n')
      const mover = openPage(machine(tight.url, await issuer.mint(u.a)), file, 0)
      const watcher = openPage(machine(tight.url, await issuer.mint(u.b)), file, 0)
      await Promise.all([mover.synced, watcher.synced])
      const seen = () => watcher.provider.awareness!.getStates().get(mover.doc.clientID)
      const seenCursors: number[] = []
      watcher.provider.awareness!.on('change', () => {
        const cursor = seen()?.cursor
        if (typeof cursor === 'number') seenCursors.push(cursor)
      })
      for (let i = 1; i <= 50; i++) mover.provider.awareness!.setLocalStateField('cursor', i)
      expect(await waitFor(() => seen()?.cursor === 50, 3000)).toBeGreaterThanOrEqual(0)
      // 真超速了(中间帧被合并),最后一帧是补发上去的;补发的照样按连接身份盖章。
      expect(tight.service.stats.presenceCoalesced).toBeGreaterThan(0)
      expect(tight.service.stats.presenceFlushed).toBeGreaterThan(0)
      expect(seenCursors.length).toBeLessThan(50)
      expect(seen()!.user.id).toBe(u.a)
      // 停住以后不再变:对端就停在最后一帧上。
      await sleep(300)
      expect(seen()!.cursor).toBe(50)
      mover.close()
      watcher.close()
    } finally {
      await tight.close()
    }
  })
})

describe('加载时核对', () => {
  it('ystate 算出来的和库里正文对不上 ⇒ 记错误日志与指标;正常加载不记', async () => {
    const group = await fx.group(u.a, [u.b])
    const file = await fx.file(group, u.a, 'mismatch.md', 'text/markdown', 'original\n')
    const t = await issuer.mint(u.a)
    const once = async () => {
      const m = machine(svc.url, t)
      const p = openPage(m, file, 0)
      await p.synced
      p.close()
      await waitFor(async () => !svc.service.hocuspocus.documents.has(`${file}@0`), 8000)
      m.socket.destroy()
    }
    await once() // 首次:按正文建、钉回 ystate
    await once() // 正对照:ystate 与正文一致
    const s0 = await stats(svc.adminUrl)
    await fx.admin.query('UPDATE chat.workspace_items SET inline_text = $1 WHERE id = $2', ['written around the group\n', file])
    await once()
    const s1 = await stats(svc.adminUrl)
    expect(s1.loadMismatch - s0.loadMismatch).toBe(1)
    expect(svc.logs.some((l) => l.level === 'error' && String(l.msg).includes('ystate and inline_text disagree') && l.itemId === file)).toBe(true)
  })
})
