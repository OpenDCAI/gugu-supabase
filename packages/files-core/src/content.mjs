// 可读内容 <-> Yjs(真源 §2.2):
//   · markdown / 其他文本:Y.Text('content');
//   · JSON(content_type 含 json):Y.Map('root'),嵌套对象转 Y.Map、数组转 Y.Array。顶层必须是对象。
//     协同文本(真源 §2.4 F8)是嵌在里面的 Y.Text:读出来是普通字符串,agent 按文本改到它时按字符 diff 并入,
//     冷压缩时连类型一起保留。建它只有一种写法,App 与 agent 同一个:正文里写 {"$text": "..."}(恰好只有这一个键、
//     值是字符串;App 的 gugu.text(s) 序列化出来就是它)。建文件、agent 编辑里新写的值、数组里的新元素都认它;
//     写进去以后它就是 Y.Text,投影回正文是普通字符串,标记不再出现。普通字符串一律是普通值(不自动升级)。
// 存盘时 inline_text 写可读内容:文本原样,JSON 是紧凑的 JSON.stringify;给 agent 看的是缩进 2 格的版本。

import * as Y from 'yjs'

export const isJson = (/** @type {string | null | undefined} */ contentType) => /json/i.test(contentType ?? '')

export class InvalidJson extends Error {
  constructor(/** @type {string} */ message) {
    super(message)
    this.reason = 'invalid-json'
  }
}

/**
 * 协同文本的正文标记 {"$text": "..."}:一个普通对象,恰好只有这一个键,值是字符串。多一个键就是普通对象;
 * 不是普通对象(类的实例等)的不算 —— 页面运行时(App 的赋值)用的也是这一条,JSON 解析出来的值本来就是普通对象。
 * @param {unknown} v @returns {v is { $text: string }}
 */
export function isTextMark(v) {
  if (!v || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) return false
  const keys = Object.keys(v)
  return keys.length === 1 && keys[0] === '$text' && typeof (/** @type {{ $text: unknown }} */ (v)).$text === 'string'
}

/** @param {unknown} v @returns {unknown} */
function toY(v) {
  if (isTextMark(v)) return new Y.Text(v.$text)
  if (Array.isArray(v)) {
    const a = new Y.Array()
    a.push(v.map(toY))
    return a
  }
  if (v && typeof v === 'object') {
    const m = new Y.Map()
    for (const [k, x] of Object.entries(v)) m.set(k, toY(x))
    return m
  }
  return v
}
const plain = (/** @type {unknown} */ v) => (v instanceof Y.Map || v instanceof Y.Array || v instanceof Y.Text ? v.toJSON() : v)
const same = (/** @type {unknown} */ a, /** @type {unknown} */ b) => JSON.stringify(a) === JSON.stringify(b)
const isObject = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * 正文里的标记换成它的字符串 —— 打开以后读正文是什么样,还没打开过的文件读出来就是什么样。
 * @param {unknown} v @returns {unknown}
 */
export function withoutMarks(v) {
  if (isTextMark(v)) return v.$text
  if (Array.isArray(v)) return v.map(withoutMarks)
  if (isObject(v)) return Object.fromEntries(Object.entries(/** @type {Record<string, unknown>} */ (v)).map(([k, x]) => [k, withoutMarks(x)]))
  return v
}

/**
 * 字符串的 UTF-8 字节数,不依赖 Node 的 Buffer:这个模块也在 App 页面里跑(运行时的合并规则就是这一份)。
 * @param {string} s
 */
export function utf8Length(s) {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (isHighSurrogate(c) && i + 1 < s.length && isLowSurrogate(s.charCodeAt(i + 1))) {
      n += 4
      i++
    } else n += 3
  }
  return n
}
const isHighSurrogate = (/** @type {number} */ c) => c >= 0xd800 && c <= 0xdbff
const isLowSurrogate = (/** @type {number} */ c) => c >= 0xdc00 && c <= 0xdfff

/** @param {string} text @returns {Record<string, unknown>} */
export function parseJsonObject(text) {
  let value
  try {
    value = JSON.parse(text === '' ? '{}' : text)
  } catch (error) {
    throw new InvalidJson(/** @type {Error} */ (error).message)
  }
  if (!isObject(value)) throw new InvalidJson('top-level value must be an object')
  return /** @type {Record<string, unknown>} */ (value)
}

/** 按正文建一份全新的状态(首次打开、冷压缩)。 */
export function buildDoc(/** @type {string} */ contentType, /** @type {string | null} */ text) {
  const doc = new Y.Doc()
  if (isJson(contentType)) {
    const obj = parseJsonObject(text ?? '')
    const root = doc.getMap('root')
    doc.transact(() => {
      for (const [k, v] of Object.entries(obj)) root.set(k, toY(v))
    })
  } else {
    doc.getText('content').insert(0, text ?? '')
  }
  return doc
}

/**
 * @param {Y.Doc} doc
 * @param {string} contentType
 * @param {{ pretty?: boolean }} [options] pretty:给人和 agent 看(缩进 2 格);否则是存进 inline_text 的紧凑形
 */
export function readText(doc, contentType, { pretty = false } = {}) {
  if (!isJson(contentType)) return doc.getText('content').toString()
  const value = doc.getMap('root').toJSON()
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)
}

/** File bytes retain the existing {$text: …} representation, so opening a copy keeps its text types. */
export function readFileText(doc, contentType) {
  if (!isJson(contentType)) return readText(doc, contentType)
  const value = (v) => v instanceof Y.Text ? { $text: v.toString() }
    : v instanceof Y.Map ? Object.fromEntries([...v.entries()].map(([k, x]) => [k, value(x)]))
      : v instanceof Y.Array ? v.toArray().map(value) : v
  return JSON.stringify(value(doc.getMap('root')))
}

/**
 * 在 ytext 的 at 处把 before 换成 after:只换真正不同的那一段 —— 前后相同的字不删不插,
 * 别人同时在旁边打的字、光标都不受影响;也不把一个代理对(emoji 等)从中间劈开。
 * @param {Y.Text} ytext @param {number} at @param {string} before @param {string} after
 */
function spliceInto(ytext, at, before, after) {
  let p = 0
  while (p < before.length && p < after.length && before[p] === after[p]) p++
  let s = 0
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++
  if (p > 0 && isHighSurrogate(before.charCodeAt(p - 1))) p--
  if (s > 0 && isLowSurrogate(before.charCodeAt(before.length - s))) s--
  const del = before.length - p - s
  const ins = after.slice(p, after.length - s)
  if (del) ytext.delete(at + p, del)
  if (ins) ytext.insert(at + p, ins)
}

/**
 * 把整段协同文本改成 next,规则同 spliceInto(只换不同的那一段、不劈开代理对)。页面运行时写一段协同文本走的也是它。
 * @param {Y.Text} ytext @param {string} next
 */
export function spliceText(ytext, next) {
  const before = ytext.toString()
  if (before !== next) spliceInto(ytext, 0, before, next)
}

/**
 * 能原地并进去就原地并(返回 true):协同文本按字符 diff,Y.Map 按键,Y.Array 按元素;值没变也算。
 * 类型对不上时返回 false,由调用方整个换掉 —— 换掉就是「后写者胜」。
 * @param {unknown} cur @param {unknown} v
 */
function mergeInto(cur, v) {
  // 协同文本收到字符串或标记,都按字符并入:类型不变,别人同时打的字留得住。
  if (cur instanceof Y.Text && (typeof v === 'string' || isTextMark(v))) {
    spliceText(cur, typeof v === 'string' ? v : v.$text)
    return true
  }
  // 标记落在别的东西上(普通字符串、Y.Map……)= 要把它换成协同文本:由调用方整个换掉。
  if (isTextMark(v)) return false
  if (cur instanceof Y.Map && isObject(v)) {
    applyJson(cur, /** @type {Record<string, unknown>} */ (v))
    return true
  }
  if (cur instanceof Y.Array && Array.isArray(v)) {
    applyArray(cur, v)
    return true
  }
  return same(plain(cur), v)
}

/** 把对象按键写回 Y.Map:没变的键不动(别人同时改的别的键得以保留),同一个键后写者胜。 */
export function applyJson(/** @type {Y.Map<unknown>} */ ymap, /** @type {Record<string, unknown>} */ obj) {
  for (const k of [...ymap.keys()]) if (!(k in obj)) ymap.delete(k)
  for (const [k, v] of Object.entries(obj)) {
    if (!ymap.has(k) || !mergeInto(ymap.get(k), v)) ymap.set(k, toY(v))
  }
}

/**
 * 把数组写回 Y.Array:前后相同的元素不动;中间对得上位置的元素原地并(里面的协同文本、Y.Map 保住身份),
 * 多出来的插、少了的删。❌ 整个数组换掉 —— 那会把数组里所有的协同文本都退化成普通字符串。
 * @param {Y.Array<unknown>} yarr @param {unknown[]} arr
 */
function applyArray(yarr, arr) {
  const old = yarr.toArray()
  let p = 0
  while (p < old.length && p < arr.length && same(plain(old[p]), arr[p])) p++
  let s = 0
  while (s < old.length - p && s < arr.length - p && same(plain(old[old.length - 1 - s]), arr[arr.length - 1 - s])) s++
  const midOld = old.length - p - s
  const midNew = arr.length - p - s
  const paired = Math.min(midOld, midNew)
  for (let i = 0; i < paired; i++) {
    if (!mergeInto(old[p + i], arr[p + i])) {
      yarr.delete(p + i, 1)
      yarr.insert(p + i, [toY(arr[p + i])])
    }
  }
  if (midOld > paired) yarr.delete(p + paired, midOld - paired)
  if (midNew > paired) yarr.insert(p + paired, arr.slice(p + paired, p + midNew).map(toY))
}

/** @param {unknown} v @returns {unknown} */
function cloneY(v) {
  if (v instanceof Y.Map) {
    const m = new Y.Map()
    for (const [k, x] of v.entries()) m.set(k, cloneY(x))
    return m
  }
  if (v instanceof Y.Array) {
    const a = new Y.Array()
    a.push(v.toArray().map(cloneY))
    return a
  }
  if (v instanceof Y.Text) {
    const t = new Y.Text()
    t.applyDelta(v.toDelta())
    return t
  }
  return v
}

/**
 * 冷压缩用:按**当前的 Yjs 结构**建一份没有历史的新状态 —— 内容与类型(协同文本、嵌套 Map / Array)都照原样,
 * 只丢掉编辑历史和删除墓碑。❌ 从 inline_text 解析重建:JSON 里的协同文本会退化成普通字符串。
 * @param {Y.Doc} source @param {string} contentType
 */
export function rebuildDoc(source, contentType) {
  const doc = new Y.Doc()
  if (isJson(contentType)) {
    const from = source.getMap('root')
    const to = doc.getMap('root')
    doc.transact(() => {
      for (const [k, v] of from.entries()) to.set(k, cloneY(v))
    })
  } else {
    doc.getText('content').applyDelta(source.getText('content').toDelta())
  }
  return doc
}

/** 两段可读内容是不是同一份(JSON 按值比,不看键序与缩进)。 */
export function sameContent(/** @type {string} */ contentType, /** @type {string} */ a, /** @type {string} */ b) {
  if (!isJson(contentType)) return a === b
  try {
    return canonical(parseJsonObject(a)) === canonical(parseJsonObject(b))
  } catch {
    return false
  }
}
/** @param {unknown} v @returns {string} */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (isObject(v)) {
    const o = /** @type {Record<string, unknown>} */ (v)
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/**
 * agent 的 edit(旧, 新):在**当前**内容(JSON 是缩进版)里找唯一的 old 替换掉。
 * 结果形如 HTTP 的回应:{ status, body }。文档只在 200 时被改动。
 * @param {Y.Doc} doc
 * @param {string} contentType
 * @param {string} oldText
 * @param {string} newText
 * @param {number} maxBytes
 */
export function applyEdit(doc, contentType, oldText, newText, maxBytes) {
  const json = isJson(contentType)
  const current = readText(doc, contentType, { pretty: true })
  const count = current.split(oldText).length - 1
  if (count !== 1) {
    return { status: 409, body: { error: count ? 'ambiguous' : 'content-changed', count, hint: 're-read the file and retry' } }
  }
  const at = current.indexOf(oldText)
  const next = current.slice(0, at) + newText + current.slice(at + oldText.length)
  if (json) {
    let obj
    try {
      obj = parseJsonObject(next)
    } catch (error) {
      return { status: 422, body: { error: 'invalid-json', message: /** @type {Error} */ (error).message } }
    }
    if (utf8Length(JSON.stringify(obj)) > maxBytes) return { status: 413, body: { error: 'too-large', limit: maxBytes } }
    doc.transact(() => applyJson(doc.getMap('root'), obj))
    return { status: 200, body: { ok: true } }
  }
  if (utf8Length(next) > maxBytes) return { status: 413, body: { error: 'too-large', limit: maxBytes } }
  const t = doc.getText('content')
  doc.transact(() => spliceInto(t, at, oldText, newText))
  return { status: 200, body: { ok: true } }
}
