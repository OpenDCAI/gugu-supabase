// 打开的文件:和存储无关的那一半。远端的文件服务(Postgres)和桌面的本地服务(磁盘,任务工作副本)共用这一份;
// 各自只管「从哪加载、存到哪、谁能打开」。
//   · 每个已加载文档的簿记:bytes = 上次量过的可读内容字节;pending = 之后收下的更新负载字节(上界用);
//     dirty = 上次存盘后有没有改动(Hocuspocus 断开时不管改没改都会存一次,没改就不写)。
//   · 限速(每个连接一组令牌桶)、单文件上限(先用上界判,逼近上限时才量真的)。
//   · presence:每个状态的 user 按连接身份盖章,页面自报的一律覆盖;别的连接的 clientID 不许动。
//     超过速率只合并、不丢最新(统筹 09-30 F38):中间帧可以不上,但这条连接收到的最新一帧总会在令牌回来时补上 ——
//     否则快速移动后停下,别人看到的光标就停在半路。补上的是原帧(clock 不变),比它新的已经上了就自然作废。
//   · 自己是谁:盖的章回不到发出方自己,所以每条文件连接认证通过后(重连也算)用 stateless 发一次 {"t":"self"}。
//   · 装上 F43 的同时建合并(concurrent.mjs)。
//   · 热压缩(F71,gugu-base notes/2026-09-29-app-platform/workspace-app/L2-F71-hot-compaction.md):文件开着时墓碑太多,
//     先排空、暂停,再换代:发 {"t":"compact"},等每条连接回
//     {"t":"drained"};都排空了就挡住新内容、按当前结构重建、交给存储写成下一代,再以 compacted:<代号> 关掉所有连接,
//     页面重开并补上自己暂停期间的改动。排空超时就发 {"t":"resume"} 作废这一轮,绝不在没排空时换代。
// 连接的 context 要带 { actorId, actorName, color }(由调用方在认证时给)。

import * as Y from 'yjs'

import { mergeConcurrentCreations } from './concurrent.mjs'
import { readText, rebuildDoc } from './content.mjs'
import { connectionLimits } from './limits.mjs'
import { stampOf } from './presence.mjs'

/** Hocuspocus 的消息类型(packages/common)与 y-protocols 的同步子类型。 */
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_SYNC_REPLY = 4
const SYNC_STEP2 = 1
const SYNC_UPDATE = 2

/** lib0 的 varUint / varString,只读消息头用。 */
export function readHead(/** @type {Uint8Array} */ bytes) {
  let pos = 0
  const varUint = () => {
    let num = 0
    let mult = 1
    for (;;) {
      if (pos >= bytes.length) throw new Error('truncated')
      const b = bytes[pos++]
      num += (b & 0x7f) * mult
      if (b < 0x80) return num
      mult *= 128
      if (mult > 2 ** 53) throw new Error('varuint too long')
    }
  }
  const nameLength = varUint()
  pos += nameLength
  const type = varUint()
  let syncType = -1
  let payloadLength = 0
  if (type === MESSAGE_SYNC || type === MESSAGE_SYNC_REPLY) {
    syncType = varUint()
    if (syncType === SYNC_STEP2 || syncType === SYNC_UPDATE) payloadLength = varUint()
  }
  return { type, syncType, payloadLength, payloadAt: pos }
}

/**
 * 关连接用的错误:Hocuspocus 在 beforeHandleMessage 抛错时按 code / reason 关掉这条文档连接。
 * @param {number} code @param {string} reason
 */
export function closeWith(code, reason) {
  return Object.assign(new Error(reason), { code, reason })
}

/**
 * @template {{ contentType: string }} Extra
 * @param {{
 *   maxBytes: number,
 *   limits: { rateUpdates: { perSecond: number, burst: number }, rateBytes: { perSecond: number, burst: number }, rateAwareness: { perSecond: number, burst: number } },
 *   log: { warn: (msg: string, fields?: object) => void, info?: (msg: string, fields?: object) => void },
 *   stats: { rateLimited: number, tooLarge: number, presenceCoalesced: number, presenceFlushed: number, concurrentMerges: { create: number, lateWrite: number }, hotCompactions?: number, compactAborted?: number },
 *   compaction?: { ratio: number, minBytes: number, cooldownMs: number, drainMs: number },
 * }} options
 */
export function createOpenFiles({ maxBytes, limits: rates, log, stats, compaction }) {
  /**
   * @type {Map<string, Extra & { bytes: number, pending: number, dirty: boolean, compacted: boolean, hotAt: number, hot: Hot | null }>}
   */
  const docs = new Map()
  // ── 热压缩(F71) ───────────────────────────────────────────────────────────
  /**
   * @typedef {{ phase: 'draining' | 'swapping', waiting: Set<any>, timer: ReturnType<typeof setTimeout>, startedAt: number,
   *   document: any, persist: (fresh: Y.Doc) => Promise<number>, reason: 'compaction' | 'replacement',
   *   done: Promise<{ epoch?: number, error?: unknown }>, resolve: (result: { epoch?: number, error?: unknown }) => void }} Hot
   */
  const say = (/** @type {any} */ connection, /** @type {object} */ message) => connection.sendStateless(JSON.stringify(message))
  const finish = (/** @type {{ hot: Hot | null }} */ info, /** @type {{ epoch?: number, error?: unknown }} */ result) => {
    const hot = info.hot
    if (!hot) return
    clearTimeout(hot.timer)
    info.hot = null
    hot.resolve(result)
  }
  /** 排空没完成(超时、存储写不进):这一轮作废,所有页面恢复发送。换代绝不在没排空时发生。 */
  const abort = (/** @type {string} */ name, /** @type {any} */ info, /** @type {unknown} */ error) => {
    const hot = info.hot
    if (!hot) return
    for (const c of hot.document.getConnections()) say(c, { t: 'resume' })
    if (hot.reason === 'compaction' && stats.compactAborted !== undefined) stats.compactAborted++
    log.warn('document generation aborted', { doc: name, reason: hot.reason, why: String(error), waiting: hot.waiting.size })
    finish(info, { error })
  }
  /** 等排空的连接里去掉已经走了的;都排空了就换代。 */
  const drainedCheck = (/** @type {string} */ name) => {
    const info = docs.get(name)
    const hot = info?.hot
    if (!hot || hot.phase !== 'draining') return
    const live = new Set(hot.document.getConnections())
    for (const c of hot.waiting) if (!live.has(c)) hot.waiting.delete(c)
    if (hot.waiting.size === 0) void swap(name, info)
  }
  const swap = async (/** @type {string} */ name, /** @type {any} */ info) => {
    const hot = /** @type {Hot} */ (info.hot)
    // 从这一刻起这个文档不再收新内容(beforeHandleMessage 挡);让已经过了钩子的帧先落地,再按当前结构重建。
    hot.phase = 'swapping'
    clearTimeout(hot.timer)
    await new Promise((resolve) => setImmediate(resolve))
    const before = Y.encodeStateAsUpdate(hot.document).length
    const fresh = rebuildDoc(hot.document, info.contentType)
    const after = Y.encodeStateAsUpdate(fresh).length
    let epoch
    try {
      epoch = await hot.persist(fresh)
    } catch (error) {
      hot.phase = 'draining'
      abort(name, info, error)
      return
    } finally {
      fresh.destroy()
    }
    info.compacted = true
    if (hot.reason === 'compaction' && stats.hotCompactions !== undefined) stats.hotCompactions++
    const connections = hot.document.getConnections()
    ;(log.info ?? log.warn)('document-generation', { doc: name, reason: hot.reason, from: before, to: after, epoch, pausedMs: Date.now() - hot.startedAt, connections: connections.length })
    // 页面按这个原因重开到新代号,补上自己暂停期间的改动。
    for (const c of connections) c.close({ code: 4409, reason: `compacted:${epoch}` })
    finish(info, { epoch })
  }
  /** Shared drain/freeze/swap for compaction and an authorized incoming replacement. */
  const startSwap = (/** @type {string} */ name, /** @type {any} */ document,
    /** @type {(fresh: Y.Doc) => Promise<number>} */ persist, /** @type {'compaction' | 'replacement'} */ reason) => {
    const info = docs.get(name)
    if (!info || info.hot || info.compacted || !compaction) throw new Error('generation-unavailable')
    const connections = document.getConnections()
    const now = Date.now()
    info.hotAt = now
    /** @type {(result: { epoch?: number, error?: unknown }) => void} */
    let resolve = () => {}
    const done = new Promise((r) => (resolve = r))
    info.hot = {
      phase: 'draining', waiting: new Set(connections),
      timer: setTimeout(() => abort(name, info, new Error('drain-timeout')), compaction.drainMs),
      startedAt: now, document, persist, reason, done, resolve,
    }
    for (const c of connections) say(c, { t: 'compact' })
    drainedCheck(name)
    return done
  }
  /** @type {WeakMap<object, ReturnType<typeof connectionLimits>>} */
  const limits = new WeakMap()
  const limitsOf = (/** @type {object} */ connection) => {
    let l = limits.get(connection)
    if (!l) limits.set(connection, (l = connectionLimits(rates)))
    return l
  }
  /**
   * presence 的尾帧:这条连接收到的最新一帧 presence(原样的整条消息),超速时压着,令牌回来时补发。
   * @type {WeakMap<object, { latest: Uint8Array | null, timer: ReturnType<typeof setTimeout> | null, flushing: boolean }>}
   */
  const held = new WeakMap()
  const heldOf = (/** @type {object} */ connection) => {
    let h = held.get(connection)
    if (!h) held.set(connection, (h = { latest: null, timer: null, flushing: false }))
    return h
  }
  /** 一个 presence 令牌回来要多久;速率配成 0 = 超过突发量就不再上(不补发,免得空转)。 */
  const refillMs = rates.rateAwareness.perSecond > 0 ? Math.ceil(1000 / rates.rateAwareness.perSecond) : null
  /** 把压着的最新一帧重新交给这条连接:它照常过限速、盖章;还超速就再压一轮。连接已经走了就算了。 */
  const flush = (/** @type {any} */ connection, /** @type {any} */ document) => {
    const h = held.get(connection)
    if (!h) return
    h.timer = null
    if (!h.latest || !document.hasConnection(connection)) return
    h.flushing = true
    connection.handleMessage(h.latest)
  }

  return {
    docs,

    /**
     * 存储已经把状态装进 `document` 之后调:装上同时建的合并,登记簿记。返回可读内容。
     * @param {Y.Doc} document @param {string} name @param {Extra} extra
     */
    attach(document, name, extra) {
      mergeConcurrentCreations(document, {
        onMerge: (kind) => {
          if (kind === 'create') stats.concurrentMerges.create++
          else stats.concurrentMerges.lateWrite++
        },
      })
      const readable = readText(document, extra.contentType)
      docs.set(name, { ...extra, bytes: Buffer.byteLength(readable), pending: 0, dirty: false, compacted: false, hotAt: 0, hot: null })
      return readable
    },

    /**
     * 存盘以后调(F71):ystate 超过 max(ratio × 正文, minBytes)、冷却已过,就开始排空;有连接不回 drained,就按排空超时作废这一轮。
     * `persist(fresh)` 由存储实现:把重建的状态写成下一代并回新代号;抛错 = 这一轮作废。回 true = 开始了。
     * @param {string} name @param {any} document @param {{ stateBytes: number, textBytes: number }} size
     * @param {(fresh: Y.Doc) => Promise<number>} persist
     */
    compactWhenDue(name, document, { stateBytes, textBytes }, persist) {
      if (!compaction) return false
      const info = docs.get(name)
      if (!info || info.hot || info.compacted) return false
      if (stateBytes <= Math.max(compaction.ratio * textBytes, compaction.minBytes)) return false
      const now = Date.now()
      if (now - info.hotAt < compaction.cooldownMs) return false
      const connections = document.getConnections()
      // 没人开着:卸载时的冷压缩会管。
      if (connections.length === 0) return false
      void startSwap(name, document, persist, 'compaction')
      return true
    },
    /** The callback works on a frozen, typed copy; a failed transaction resumes the unchanged live document. */
    async swapGeneration(/** @type {string} */ name, /** @type {any} */ document, /** @type {(fresh: Y.Doc) => Promise<number>} */ persist) {
      const result = await startSwap(name, document, persist, 'replacement')
      if (result.error) throw result.error
      return /** @type {number} */ (result.epoch)
    },
    /** 这个文件正在换代:新的内容一律挡(agent 的 HTTP edit 要等 `settled` 以后在新代号上做)。 */
    frozen(/** @type {string} */ name) {
      const info = docs.get(name)
      return !!info && (info.compacted || info.hot?.phase === 'swapping')
    },
    /** 这一轮热压缩结束(成或不成)。没有在压就立刻结束。 */
    settled(/** @type {string} */ name) {
      return docs.get(name)?.hot?.done.then(() => {}) ?? Promise.resolve()
    },

    /**
     * 存盘要写的东西。写成功以后调 `stored(name, snap)`。
     * @param {string} name @param {Y.Doc} document
     */
    snapshot(name, document) {
      const info = docs.get(name)
      if (!info) throw new Error(`not attached: ${name}`)
      const text = readText(document, info.contentType)
      return { state: Y.encodeStateAsUpdate(document), text, bytes: Buffer.byteLength(text), pendingAt: info.pending }
    },
    /** @param {string} name @param {{ bytes: number, pendingAt: number }} snap */
    stored(name, snap) {
      const info = docs.get(name)
      if (!info) return
      info.bytes = snap.bytes
      info.pending -= snap.pendingAt
    },

    /** 要并进 Hocuspocus Server 配置的那几个钩子。 */
    hooks: {
      /** @param {{ connection: any, document: any, update: Uint8Array }} data */
      async beforeHandleMessage({ connection, document, update }) {
        const lim = limitsOf(connection)
        if (!lim.updates.take(1) || !lim.bytes.take(update.length)) {
          stats.rateLimited++
          log.warn('rate limited; closing connection', { doc: document.name, actorId: connection.context?.actorId })
          throw closeWith(4429, 'rate-limited')
        }
        let head
        try {
          head = readHead(update)
        } catch {
          throw closeWith(4400, 'bad-message')
        }
        // 记下最新的 presence 原帧:超速时补发的就是它。
        if (head.type === MESSAGE_AWARENESS) heldOf(connection).latest = update.slice()
        const isContent = (head.type === MESSAGE_SYNC || head.type === MESSAGE_SYNC_REPLY) && head.payloadLength > 0
        if (!isContent) return
        const info = docs.get(document.name)
        if (!info) return
        // 换代中:不收、不确认 —— 页面重开到新代号后自己补上(F71)。
        if (info.compacted || info.hot?.phase === 'swapping') throw closeWith(4409, 'compacting')
        // 上限:先用「上次量过的 + 之后收下的负载」这个上界判,超了才量真的;还超就在副本上试一次(只在逼近上限时发生)。
        if (info.bytes + info.pending + head.payloadLength > maxBytes) {
          info.bytes = Buffer.byteLength(readText(document, info.contentType))
          info.pending = 0
          if (info.bytes + head.payloadLength > maxBytes) {
            const trial = new Y.Doc()
            try {
              Y.applyUpdate(trial, Y.encodeStateAsUpdate(document))
              Y.applyUpdate(trial, update.subarray(head.payloadAt, head.payloadAt + head.payloadLength))
              const after = Buffer.byteLength(readText(trial, info.contentType))
              if (after > maxBytes) {
                stats.tooLarge++
                log.warn('update would exceed the file size limit; closing connection', { doc: document.name, after, limit: maxBytes })
                throw closeWith(4413, 'too-large')
              }
            } finally {
              trial.destroy()
            }
          }
        }
        info.pending += head.payloadLength
      },

      /** @param {{ connection?: any, document: any, states: Map<number, any> }} data */
      async beforeHandleAwareness({ connection, document, states }) {
        if (!connection) return
        const h = heldOf(connection)
        if (!limitsOf(connection).awareness.take(1)) {
          // 合并,不丢最新:这一帧先不上;令牌回来时补发这条连接收到的最新一帧(可能就是这一帧,也可能是之后的)。
          stats.presenceCoalesced++
          h.flushing = false
          states.clear()
          if (refillMs !== null) h.timer ??= setTimeout(() => flush(connection, document), refillMs)
          return
        }
        // 这一帧照常上:比它早压着的都旧了,不用再补。
        if (h.timer) clearTimeout(h.timer)
        h.timer = null
        if (h.flushing) stats.presenceFlushed++
        h.flushing = false
        const ctx = connection.context
        for (const [clientId, state] of states) {
          const owner = document.getConnections().find((/** @type {any} */ c) => c !== connection && document.getClients(c).has(clientId))
          if (owner) {
            states.delete(clientId)
            continue
          }
          if (state && typeof state === 'object') state.user = stampOf(ctx)
        }
      },

      /** @param {{ connection: any, context: any, documentName: string }} data */
      async connected({ connection, context, documentName }) {
        connection.sendStateless(JSON.stringify({ t: 'self', user: stampOf(context) }))
        // 排空期间新连上的:一连上就让它也排空(F71);它不回 drained 就等超时作废。
        const hot = docs.get(documentName)?.hot
        if (hot?.phase === 'draining') {
          hot.waiting.add(connection)
          say(connection, { t: 'compact' })
        }
      },

      /** 页面的 stateless:排空完成(F71)。别的原样放过。 @param {{ connection: any, documentName: string, payload: string }} data */
      async onStateless({ connection, documentName, payload }) {
        let message
        try {
          message = JSON.parse(payload)
        } catch {
          return
        }
        if (message?.t === 'drained') {
          docs.get(documentName)?.hot?.waiting.delete(connection)
          drainedCheck(documentName)
        }
      },

      /** 有连接走了:它不用再排空(F71)。 @param {{ documentName: string }} data */
      async onDisconnect({ documentName }) {
        drainedCheck(documentName)
      },

      /** @param {{ documentName: string }} data */
      async onChange({ documentName }) {
        const info = docs.get(documentName)
        if (info) info.dirty = true
      },
    },
  }
}
