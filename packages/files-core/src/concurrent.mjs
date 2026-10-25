// 同时建同一条嵌套路径:两边都留下(F43;设计、比较与原型读数见 gugu-base
// notes/2026-09-29-app-platform/workspace-app/L2-F43-nested-create.md)。
//
// App 写 f.data.votes[a][b] = 1 时,缺的中间对象由写的那一端新建。两端(人和人,或人和 agent)同时第一次写同一条
// 路径,就各建一个中间 Y.Map 放进同一个键 —— Y.Map 的键后写者胜,输的那个连同里面的内容被静默删掉。
// 所有更新都经过文件服务,所以在这一处修:某个键上的 map 输给了一个「同时建」的 map,就把输家的内容并进胜者。
//   · 只修同时建:胜者的 origin 就是输家 = 写胜者的一端看见过它 = 有意替换(比如重置),不修。
//   · 规则只有一条:map 的键是地址,两边取并集(递归);键上别的值(数组、协同文本、数字、字符串)是值,胜者留下 ——
//     整个数组赋值同一个键仍是后写者胜(真源 §2.4「同一个键后写者胜」)。
//   · 输的一端在得知之前还会往自己那个 map 里写。父级已删,Yjs 不把这些写记进 tr.changed,所以扫本事务新加的结构,
//     按相对路径转写进胜者(map 键照写,数组接在后面)。
//   · 被替换掉的 map 不做 GC(`keepReplacedMaps`),直到文档卸载、冷压缩按当前结构重建时才清掉:
//     服务端靠它接住迟到的写;页面也要装同一条规则 —— 离线的一端重连时先收到胜者、本地就判自己输了,
//     没有它的话,自己那份内容在发给服务端之前就被本地 GC 掉了。
//   · 修复就是一个普通事务:和别的更新走同一条广播、存盘路径。
// 读的是 Yjs 的内部结构(_map、item.origin / left / parentSub、store.clients、gcFilter):yjs 钉的是精确版本,
// 每一种情形都有单测,升级时一跑就知道。

import * as Y from 'yjs'

const MERGE = Symbol('files:concurrent-create')

// A repair still has its own origin for sync/broadcast and recursion, while retaining the
// transaction that caused it so persistence can identify the actual content writer.
/** @param {any} origin @returns {unknown} */
export function contentOriginOf(origin) {
  return origin?.merge === MERGE ? origin.cause : origin
}

/** @param {Y.Transaction} tr @param {Y.Item} item */
const deletedHere = (tr, item) => Y.isDeleted(tr.deleteSet, item.id)
/** @param {Y.Item | null | undefined} item */
const mapValueOf = (item) => (item && item.parentSub !== null && /** @type {any} */ (item.content).type instanceof Y.Map ? /** @type {Y.Map<any>} */ (/** @type {any} */ (item.content).type) : null)

/**
 * 某个键上被**别的值顶掉**的 map:同一个键的各个值在 Yjs 里从旧到新串在一起(left / right),被顶掉的右边有更新的值。
 * 直接 `delete` 掉的右边什么都没有 —— 那种照常回收(F61:否则每删一次就无上限地留一份)。
 * @param {Y.Item} item
 */
const replacedMap = (item) => item.parentSub !== null && item.right !== null && /** @type {any} */ (item.content).type instanceof Y.Map

/**
 * 被替换掉的 map 连同它下面的一切,不做 GC。直接删掉的 map、协同文本里删掉的字照常回收。
 * 文件服务和页面运行时都装这一条(同一个包,只有这一份)。
 * @param {Y.Doc} doc
 */
export function keepReplacedMaps(doc) {
  const gcFilter = doc.gcFilter
  doc.gcFilter = (item) => {
    for (let it = /** @type {Y.Item | null} */ (item); it; it = /** @type {any} */ (it.parent)?._item ?? null) {
      if (it.deleted && replacedMap(it)) return false
    }
    return gcFilter(item)
  }
}

/**
 * 一个 map 在本事务删掉它之前的内容(同一事务里连带删掉的算,早先删掉的不算),读成普通数据。
 * @typedef {{ map: Record<string, Snap> } | { array: Snap[] } | { text: string } | { value: unknown }} Snap
 * `keep` 选这一层的条目,`nested` 选更深的(缺省同 `keep`)。
 * @param {Y.AbstractType<any>} type @param {(item: Y.Item) => boolean} keep @param {(item: Y.Item) => boolean} [nested]
 * @returns {Snap}
 */
function snapshot(type, keep, nested = keep) {
  if (type instanceof Y.Map) {
    /** @type {Record<string, Snap>} */
    const map = {}
    for (const [key, item] of type._map) if (keep(item)) map[key] = snapItem(item, nested)
    return { map }
  }
  /** @type {Y.Item[]} */
  const items = []
  for (let n = type._start; n; n = n.right) if (n.countable && keep(n)) items.push(n)
  if (type instanceof Y.Text) return { text: items.map((n) => /** @type {any} */ (n.content).str ?? '').join('') }
  return { array: items.flatMap((n) => (/** @type {any} */ (n.content).type ? [snapItem(n, nested)] : n.content.getContent().map((value) => ({ value })))) }
}
/** @param {Y.Item} item @param {(item: Y.Item) => boolean} keep @returns {Snap} */
function snapItem(item, keep) {
  const type = /** @type {any} */ (item.content).type
  return type instanceof Y.AbstractType ? snapshot(type, keep) : { value: item.content.getContent().at(-1) }
}
/** @param {Snap} s @returns {unknown} */
function build(s) {
  if ('map' in s) {
    const m = new Y.Map()
    for (const [k, v] of Object.entries(s.map)) m.set(k, build(v))
    return m
  }
  if ('array' in s) {
    const a = new Y.Array()
    a.push(s.array.map(build))
    return a
  }
  if ('text' in s) return new Y.Text(s.text)
  return s.value
}
/**
 * 并进 `target`。'union'(同时建):胜者没有的键补上,两边都是 map 就递归,别的键胜者留下。
 * 'late'(迟到的写):这是输的一端后来写的,照写 —— map 键覆盖、map 对 map 递归,数组接在后面。
 * @param {Y.AbstractType<any>} target @param {Snap} s @param {'union' | 'late'} mode
 */
function mergeInto(target, s, mode) {
  if (target instanceof Y.Map && 'map' in s) {
    for (const [key, v] of Object.entries(s.map)) {
      const current = target.get(key)
      if (current instanceof Y.Map && 'map' in v) mergeInto(current, v, mode)
      else if (!target.has(key) || mode === 'late') target.set(key, build(v))
    }
  } else if (target instanceof Y.Array && 'array' in s && mode === 'late') target.push(s.array.map(build))
}

/** `type` 在 `ancestor` 之下的相对路径(map 的键、数组的下标)。 */
function pathBelow(/** @type {Y.AbstractType<any>} */ ancestor, /** @type {Y.AbstractType<any>} */ type) {
  /** @type {(string | number)[]} */
  const keys = []
  for (let t = type; t !== ancestor; ) {
    const item = t._item
    if (!item) return null
    if (item.parentSub !== null) keys.unshift(item.parentSub)
    else {
      let index = 0
      for (let n = /** @type {any} */ (item.parent)._start; n && n !== item; n = n.right) if (n.countable && !n.deleted) index++
      keys.unshift(index)
    }
    t = /** @type {Y.AbstractType<any>} */ (item.parent)
  }
  return keys
}
/** 在 `root` 下按路径走;map 上缺的一层就建一个空 map(像页面写这条路径时那样),数组下标缺了就算了。 */
function follow(/** @type {Y.AbstractType<any>} */ root, /** @type {(string | number)[]} */ keys) {
  let t = root
  for (const key of keys) {
    let next = t instanceof Y.Map ? t.get(/** @type {string} */ (key)) : /** @type {Y.Array<any>} */ (t).get(/** @type {number} */ (key))
    if (next === undefined && t instanceof Y.Map) t.set(/** @type {string} */ (key), (next = new Y.Map()))
    if (!(next instanceof Y.AbstractType)) return null
    t = next
  }
  return t
}

/**
 * 装到文件服务加载好的文档上;文档的整个生命周期里有效。
 * @param {Y.Doc} doc
 * @param {{ onMerge?: (kind: 'create' | 'late-write') => void }} [hooks]
 */
export function mergeConcurrentCreations(doc, { onMerge } = {}) {
  keepReplacedMaps(doc)
  /** @type {WeakMap<Y.AbstractType<any>, Y.AbstractType<any>>} 修过的输家 → 胜者 */
  const winnerOf = new WeakMap()
  const loserAbove = (/** @type {Y.AbstractType<any> | null} */ t) => {
    while (t && !winnerOf.has(t)) t = /** @type {any} */ (t._item?.parent) ?? null
    return t
  }
  /**
   * 并的时候才定落点:一个 map 可能先是胜者、同一轮里又输给第三方(三方同时建)。落点若已被删,就找它上面那个
   * 修过的输家,按相对路径走到那个输家的胜者里,一直走到活着的为止。
   * @param {Y.AbstractType<any>} target @returns {Y.AbstractType<any> | null}
   */
  function live(target) {
    let t = target
    for (let hops = 0; t._item?.deleted; hops++) {
      const loser = loserAbove(t)
      const keys = loser && pathBelow(loser, t)
      const next = keys && follow(/** @type {Y.AbstractType<any>} */ (winnerOf.get(loser)), keys)
      if (!next || hops > 64) return null
      t = next
    }
    return t
  }

  doc.on('afterTransaction', (/** @type {Y.Transaction} */ tr) => {
    if (tr.origin?.merge === MERGE) return
    /** @type {[Y.AbstractType<any>, Snap, 'create' | 'late-write'][]} */
    const plans = []
    /** @type {Set<Y.AbstractType<any>>} 本事务里判出来的输家:它下面新加的东西已在快照里,不再当迟到的写 */
    const lostNow = new Set()

    // ① 同时建:某个键上的胜者是 map,它左边有本事务里被删的 map,且胜者不是看着它写的
    for (const [type, keys] of tr.changed) {
      if (!(type instanceof Y.Map)) continue
      for (const key of keys) {
        if (key === null) continue
        const winner = type._map.get(key)
        const winnerMap = winner && !winner.deleted ? mapValueOf(winner) : null
        if (!winner || !winnerMap) continue
        for (let l = winner.left; l; l = l.left) {
          const loserMap = mapValueOf(l)
          if (!loserMap || !deletedHere(tr, l)) continue
          if (winner.origin && Y.compareIDs(winner.origin, l.id)) break // 有意替换
          plans.push([winnerMap, snapshot(loserMap, (item) => !item.deleted || deletedHere(tr, item)), 'create'])
          winnerOf.set(loserMap, winnerMap)
          lostNow.add(loserMap)
        }
      }
    }

    // ② 迟到的写:本事务新加的结构里,父级已删、且落在某个早先修过的输家之下的。父级本身也是本事务新加的就跳过 ——
    //    它连同下面的内容会在父级那一层的快照里。
    const aliveThen = (/** @type {Y.Item} */ item) => !item.deleted || deletedHere(tr, item)
    const newHere = (/** @type {Y.Item | null} */ item) => !!item && item.id.clock >= (tr.beforeState.get(item.id.client) ?? 0)
    /** @type {Map<Y.AbstractType<any>, Set<Y.Item>>} */
    const late = new Map()
    for (const [client, after] of tr.afterState) {
      const before = tr.beforeState.get(client) ?? 0
      if (after <= before) continue
      const structs = doc.store.clients.get(client) ?? []
      for (let i = structs.length - 1; i >= 0 && structs[i].id.clock + structs[i].length > before; i--) {
        const s = structs[i]
        const parent = /** @type {any} */ (s).parent
        if (!(s instanceof Y.Item) || !(parent instanceof Y.AbstractType) || !parent._item?.deleted || newHere(parent._item)) continue
        const loser = loserAbove(parent)
        if (!loser || lostNow.has(loser)) continue
        if (!late.has(parent)) late.set(parent, new Set())
        late.get(parent)?.add(s)
      }
    }
    for (const [parent, items] of late) plans.push([parent, snapshot(parent, (item) => items.has(item), aliveThen), 'late-write'])

    // 快照已在 GC 之前取好;并在下一个事务里做,和别的更新一样广播、存盘
    if (plans.length) {
      queueMicrotask(() => {
        /** @type {('create' | 'late-write')[]} */
        const done = []
        doc.transact(() => {
          for (const [target, snap, kind] of plans) {
            const into = live(target)
            if (!into) continue
            mergeInto(into, snap, kind === 'create' ? 'union' : 'late')
            done.push(kind)
          }
        }, { merge: MERGE, cause: tr.origin })
        for (const kind of done) onMerge?.(kind)
      })
    }
  })
}
