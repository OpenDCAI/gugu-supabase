import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'

import {
  applyEdit,
  applyJson,
  buildDoc,
  isTextMark,
  parseJsonObject,
  readText,
  rebuildDoc,
  sameContent,
  spliceText,
  utf8Length,
  withoutMarks,
} from '../../../packages/files-core/src/content.mjs'

describe('files content:可读内容 <-> Yjs', () => {
  it('markdown 原样往返;JSON 存紧凑形、给 agent 缩进 2 格', () => {
    const md = buildDoc('text/markdown', '# 标题\n正文 😀\n')
    expect(readText(md, 'text/markdown')).toBe('# 标题\n正文 😀\n')
    const json = buildDoc('application/json', '{"a": {"b": [1, {"c": 2}]}, "d": "x"}')
    expect(readText(json, 'application/json')).toBe('{"a":{"b":[1,{"c":2}]},"d":"x"}')
    expect(readText(json, 'application/json', { pretty: true })).toBe(JSON.stringify({ a: { b: [1, { c: 2 }] }, d: 'x' }, null, 2))
    expect(json.getMap('root').get('a')).toBeInstanceOf(Y.Map)
    expect((json.getMap('root').get('a') as Y.Map<unknown>).get('b')).toBeInstanceOf(Y.Array)
  })

  it('JSON 顶层必须是对象;空正文当 {}', () => {
    expect(() => parseJsonObject('[1,2]')).toThrow(/object/)
    expect(() => parseJsonObject('{')).toThrow()
    expect(parseJsonObject('')).toEqual({})
  })

  it('sameContent:JSON 按值比(键序、缩进都不算),文本逐字比', () => {
    expect(sameContent('application/json', '{"a":1,"b":2}', '{\n  "b": 2,\n  "a": 1\n}')).toBe(true)
    expect(sameContent('application/json', '{"a":1}', '{"a":2}')).toBe(false)
    expect(sameContent('application/json', '{"a":1}', 'not json')).toBe(false)
    expect(sameContent('text/markdown', 'a', 'a ')).toBe(false)
  })
})

describe('files content:edit(旧, 新)', () => {
  const LIMIT = 1024

  it('唯一处替换;找不到 409 content-changed;多处 409 ambiguous(带 count);都不动文档', () => {
    const doc = buildDoc('text/markdown', 'one two two\n')
    expect(applyEdit(doc, 'text/markdown', 'three', 'x', LIMIT)).toMatchObject({ status: 409, body: { error: 'content-changed' } })
    expect(applyEdit(doc, 'text/markdown', 'two', 'x', LIMIT)).toMatchObject({ status: 409, body: { error: 'ambiguous', count: 2 } })
    expect(readText(doc, 'text/markdown')).toBe('one two two\n')
    expect(applyEdit(doc, 'text/markdown', 'one', '1', LIMIT)).toEqual({ status: 200, body: { ok: true } })
    expect(readText(doc, 'text/markdown')).toBe('1 two two\n')
  })

  it('只换真正不同的那一段:别的副本同时在旁边打的字留得住', () => {
    const a = buildDoc('text/markdown', '第一句：旧的说法。\n')
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    // B 在「旧的」前面插字;A(agent)同时把整句的「旧的」换成「新的」
    b.getText('content').insert(3, '【B】')
    expect(applyEdit(a, 'text/markdown', '第一句：旧的说法。', '第一句：新的说法。', LIMIT).status).toBe(200)
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(readText(a, 'text/markdown')).toBe('第一句【B】：新的说法。\n')
    expect(readText(b, 'text/markdown')).toBe(readText(a, 'text/markdown'))
  })

  it('不把代理对从中间劈开', () => {
    const doc = buildDoc('text/markdown', 'x😀y\n')
    expect(applyEdit(doc, 'text/markdown', 'x😀y', 'x😁y', LIMIT).status).toBe(200)
    expect(readText(doc, 'text/markdown')).toBe('x😁y\n')
  })

  it('超过上限 413 too-large,文档不动', () => {
    const doc = buildDoc('text/markdown', 'small\n')
    expect(applyEdit(doc, 'text/markdown', 'small', 'x'.repeat(LIMIT + 1), LIMIT)).toMatchObject({ status: 413, body: { error: 'too-large' } })
    expect(readText(doc, 'text/markdown')).toBe('small\n')
  })

  it('JSON:改文本 → 解析 → 按键写回;解析失败 422 invalid-json,文档不动;没变的键不重建', () => {
    const doc = buildDoc('application/json', '{"keep":{"n":1},"food":[3,4]}')
    const kept = doc.getMap('root').get('keep')
    const pretty = readText(doc, 'application/json', { pretty: true })
    const food = pretty.slice(pretty.indexOf('"food"'), pretty.indexOf(']') + 1)
    expect(applyEdit(doc, 'application/json', food, '"food": [7, 7],\n  "round": 2', LIMIT).status).toBe(200)
    expect(doc.getMap('root').toJSON()).toEqual({ keep: { n: 1 }, food: [7, 7], round: 2 })
    expect(doc.getMap('root').get('keep')).toBe(kept) // 同一个 Y.Map:别人同时改 keep 里的键不会被冲掉
    expect(applyEdit(doc, 'application/json', '"round": 2', '"round": 2,,', LIMIT)).toMatchObject({ status: 422, body: { error: 'invalid-json' } })
    expect(applyEdit(doc, 'application/json', '"keep": {', '"keep": [', LIMIT)).toMatchObject({ status: 422, body: { error: 'invalid-json' } })
    expect(doc.getMap('root').toJSON()).toEqual({ keep: { n: 1 }, food: [7, 7], round: 2 })
  })
})

/** F8 之前的 applyJson(对照用):Y.Map 按键递归,其余一律整个换掉。 */
function applyJsonBefore(ymap: Y.Map<unknown>, obj: Record<string, unknown>) {
  const toY = (v: unknown): unknown => {
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
  const plain = (v: unknown) => (v instanceof Y.Map || v instanceof Y.Array ? v.toJSON() : v)
  for (const k of [...ymap.keys()]) if (!(k in obj)) ymap.delete(k)
  for (const [k, v] of Object.entries(obj)) {
    const cur = ymap.get(k)
    if (cur instanceof Y.Map && v && typeof v === 'object' && !Array.isArray(v)) applyJsonBefore(cur, v as Record<string, unknown>)
    else if (JSON.stringify(plain(cur)) !== JSON.stringify(v)) ymap.set(k, toY(v))
  }
}

/** 两份副本互相补齐。 */
function exchange(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
}

/** 一份带协同文本的 JSON 文件:两页幻灯片,正文是 gugu.text() 建的 Y.Text。 */
function deck(): Y.Doc {
  const doc = buildDoc('application/json', '{"title":"周会","slides":[{"title":"一","body":""},{"title":"二","body":""}]}')
  const slides = doc.getMap('root').get('slides') as Y.Array<Y.Map<unknown>>
  doc.transact(() => {
    slides.get(0).set('body', new Y.Text('hello world'))
    slides.get(1).set('body', new Y.Text('第二页'))
  })
  return doc
}
const bodyOf = (doc: Y.Doc, i: number) => ((doc.getMap('root').get('slides') as Y.Array<Y.Map<unknown>>).get(i).get('body'))

describe('files content:JSON 里的协同文本(F8)', () => {
  const LIMIT = 1024 * 1024

  it('agent 按文本改到协同文本字段 ⇒ 按字符并入:类型保住,别人同时打的字也保住', () => {
    const server = deck()
    const typist = new Y.Doc()
    Y.applyUpdate(typist, Y.encodeStateAsUpdate(server))
    ;(bodyOf(typist, 0) as Y.Text).insert(11, '!!') // 同时,另一个人在句末打字
    const pretty = readText(server, 'application/json', { pretty: true })
    expect(pretty).toContain('"body": "hello world"') // agent 看到的是普通字符串
    expect(applyEdit(server, 'application/json', '"body": "hello world"', '"body": "hi world"', LIMIT).status).toBe(200)
    exchange(server, typist)
    expect(bodyOf(server, 0)).toBeInstanceOf(Y.Text)
    expect(bodyOf(server, 0)!.toString()).toBe('hi world!!')
    expect(bodyOf(typist, 0)!.toString()).toBe('hi world!!')
    expect(readText(server, 'application/json')).toContain('"body":"hi world!!"') // inline_text 照样是普通 JSON 字符串
  })

  it('对照 —— 以前的整段替换:字段退化成普通字符串,别人同时打的字丢了', () => {
    const server = deck()
    const typist = new Y.Doc()
    Y.applyUpdate(typist, Y.encodeStateAsUpdate(server))
    ;(bodyOf(typist, 0) as Y.Text).insert(11, '!!')
    const obj = parseJsonObject(readText(server, 'application/json'))
    ;((obj.slides as Array<Record<string, unknown>>)[0]!).body = 'hi world'
    server.transact(() => applyJsonBefore(server.getMap('root'), obj))
    exchange(server, typist)
    expect(typeof bodyOf(server, 0)).toBe('string')
    expect(bodyOf(server, 0)).toBe('hi world')
  })

  it('数组:改一页,两页的协同文本都还是原来那个对象;增删页只动增删的那一页', () => {
    const doc = deck()
    const first = bodyOf(doc, 0)
    const second = bodyOf(doc, 1)
    expect(applyEdit(doc, 'application/json', '"body": "第二页"', '"body": "第二页(改)"', LIMIT).status).toBe(200)
    expect(bodyOf(doc, 0)).toBe(first)
    expect(bodyOf(doc, 1)).toBe(second)
    expect(second!.toString()).toBe('第二页(改)')
    const obj = parseJsonObject(readText(doc, 'application/json'))
    const slides = obj.slides as Array<Record<string, unknown>>
    doc.transact(() => applyJson(doc.getMap('root'), { ...obj, slides: [{ title: '零', body: '' }, ...slides] }))
    expect(bodyOf(doc, 1)).toBe(first)
    expect(bodyOf(doc, 2)).toBe(second)
    doc.transact(() => applyJson(doc.getMap('root'), { ...obj, slides: [slides[1]] }))
    expect(bodyOf(doc, 0)).toBe(second)
  })

  it('新增的普通字符串字段就是普通值:不自动升级成协同文本', () => {
    const doc = deck()
    expect(applyEdit(doc, 'application/json', '"title": "周会"', '"title": "周会",\n  "note": "x"', LIMIT).status).toBe(200)
    expect(typeof doc.getMap('root').get('note')).toBe('string')
  })

  it('冷压缩按当前结构重建:协同文本保住类型,内容一字不差,历史没了;对照 —— 按 inline_text 解析重建,字段退化成普通字符串', () => {
    const doc = deck()
    const body = bodyOf(doc, 0) as Y.Text
    // 一段真实的打字历史:随处插字、随处删字(删掉的字在状态里留墓碑,正文却不长)
    let seed = 3
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let i = 0; i < 3000; i++) {
      if (body.length > 0 && rnd() < 0.35) body.delete(Math.floor(rnd() * body.length), 1)
      else body.insert(Math.floor(rnd() * (body.length + 1)), String.fromCharCode(97 + Math.floor(rnd() * 26)))
    }
    const rebuilt = rebuildDoc(doc, 'application/json')
    expect(bodyOf(rebuilt, 0)).toBeInstanceOf(Y.Text)
    expect(bodyOf(rebuilt, 1)).toBeInstanceOf(Y.Text)
    expect(readText(rebuilt, 'application/json')).toBe(readText(doc, 'application/json'))
    expect(Y.encodeStateAsUpdate(rebuilt).length).toBeLessThan(Y.encodeStateAsUpdate(doc).length / 4)
    const before = buildDoc('application/json', readText(doc, 'application/json'))
    expect(typeof bodyOf(before, 0)).toBe('string')
  })

  it('冷压缩对文本文件照旧:内容一字不差', () => {
    const doc = buildDoc('text/markdown', '# 标题\n正文 😀\n')
    const t = doc.getText('content')
    for (let i = 0; i < 300; i++) {
      t.insert(3, 'y')
      t.delete(3, 1)
    }
    const rebuilt = rebuildDoc(doc, 'text/markdown')
    expect(readText(rebuilt, 'text/markdown')).toBe('# 标题\n正文 😀\n')
  })
})

describe('files content:协同文本的正文标记 {"$text": "..."}', () => {
  const LIMIT = 1024 * 1024
  const JSON_TYPE = 'application/json'
  const MARKED = JSON.stringify({
    title: { $text: '周会' },
    slides: [{ title: '一', body: { $text: 'hello world' } }, { $text: '一整页的字' }],
    meta: { $text: 'x', k: 1 },
    plain: '普通字符串',
  })
  const root = (doc: Y.Doc) => doc.getMap('root')
  const slide = (doc: Y.Doc, i: number) => (root(doc).get('slides') as Y.Array<unknown>).get(i)

  it('判据:恰好只有 $text 一个键、值是字符串;多一个键、值不是字符串都不是', () => {
    expect(isTextMark({ $text: '' })).toBe(true)
    expect(isTextMark({ $text: 'x', k: 1 })).toBe(false)
    expect(isTextMark({ $text: 1 })).toBe(false)
    expect(isTextMark({ text: 'x' })).toBe(false)
    expect(isTextMark([{ $text: 'x' }])).toBe(false)
    expect(isTextMark('x')).toBe(false)
    // 不是普通对象的不算(页面运行时同一条):只带 $text 键的类实例、数组都不是;没有原型的普通对象算。
    class Marked {
      $text = 'x'
    }
    expect(isTextMark(new Marked())).toBe(false)
    expect(isTextMark(Object.assign(Object.create(null), { $text: 'x' }))).toBe(true)
    expect(isTextMark(Object.assign([], { $text: 'x' }))).toBe(false)
  })

  it('建完读回来是字符串:标记建成 Y.Text(数组元素里也是),投影里没有标记;带别的键的对象照旧是 map', () => {
    const doc = buildDoc(JSON_TYPE, MARKED)
    expect(root(doc).get('title')).toBeInstanceOf(Y.Text)
    expect((slide(doc, 0) as Y.Map<unknown>).get('body')).toBeInstanceOf(Y.Text)
    expect(slide(doc, 1)).toBeInstanceOf(Y.Text)
    expect(root(doc).get('meta')).toBeInstanceOf(Y.Map)
    expect(typeof root(doc).get('plain')).toBe('string') // 普通字符串不自动升级
    const projected = {
      title: '周会',
      slides: [{ title: '一', body: 'hello world' }, '一整页的字'],
      meta: { $text: 'x', k: 1 },
      plain: '普通字符串',
    }
    expect(JSON.parse(readText(doc, JSON_TYPE))).toEqual(projected)
    expect(JSON.parse(readText(doc, JSON_TYPE, { pretty: true }))).toEqual(projected)
    // 还没建状态时的投影(读正文的那条路)与建完以后读到的一样
    expect(withoutMarks(JSON.parse(MARKED))).toEqual(projected)
    // 文件服务据此判断「正文里有标记、要换成投影」
    expect(sameContent(JSON_TYPE, readText(doc, JSON_TYPE), MARKED)).toBe(false)
    expect(sameContent(JSON_TYPE, readText(doc, JSON_TYPE), readText(doc, JSON_TYPE, { pretty: true }))).toBe(true)
  })

  it('agent 编辑按字符并入:由标记建的协同文本,agent 按文本改,别人同时打的字留得住,类型不变', () => {
    const server = buildDoc(JSON_TYPE, MARKED)
    const typist = new Y.Doc()
    Y.applyUpdate(typist, Y.encodeStateAsUpdate(server))
    const body = (doc: Y.Doc) => (slide(doc, 0) as Y.Map<unknown>).get('body') as Y.Text
    body(typist).insert(11, '!!') // 同时,有人在句末打字
    expect(readText(server, JSON_TYPE, { pretty: true })).toContain('"body": "hello world"') // agent 看到的是普通字符串
    expect(applyEdit(server, JSON_TYPE, '"body": "hello world"', '"body": "hi world"', LIMIT).status).toBe(200)
    exchange(server, typist)
    expect(body(server)).toBeInstanceOf(Y.Text)
    expect(body(server).toString()).toBe('hi world!!')
    expect(body(typist).toString()).toBe('hi world!!')
  })

  it('agent 编辑里写标记:新键建成 Y.Text;普通字符串上写标记 = 升级;已有 Y.Text 上写标记 = 按字符并入', () => {
    const doc = buildDoc(JSON_TYPE, MARKED)
    const typist = new Y.Doc()
    Y.applyUpdate(typist, Y.encodeStateAsUpdate(doc))
    ;(root(typist).get('title') as Y.Text).insert(0, '·') // 同时有人在标题前面打字
    const title = root(doc).get('title')
    expect(
      applyEdit(doc, JSON_TYPE, '"plain": "普通字符串"', '"plain": {"$text": "普通字符串"},\n  "summary": {"$text": "要点"}', LIMIT).status,
    ).toBe(200)
    expect(root(doc).get('plain')).toBeInstanceOf(Y.Text)
    expect(root(doc).get('summary')).toBeInstanceOf(Y.Text)
    expect(readText(doc, JSON_TYPE)).toContain('"summary":"要点"')
    // 已有协同文本上写标记:还是原来那个 Y.Text,字按差异并入
    const obj = parseJsonObject(readText(doc, JSON_TYPE))
    doc.transact(() => applyJson(root(doc), { ...obj, title: { $text: '周会纪要' } }))
    expect(root(doc).get('title')).toBe(title)
    exchange(doc, typist)
    expect(String(root(doc).get('title'))).toBe('·周会纪要')
    // 协同文本遇到对象或数字:整个换掉
    doc.transact(() => applyJson(root(doc), { ...parseJsonObject(readText(doc, JSON_TYPE)), summary: 3 }))
    expect(root(doc).get('summary')).toBe(3)
  })

  it('冷压缩后由标记建的协同文本保住类型', () => {
    const doc = buildDoc(JSON_TYPE, MARKED)
    const rebuilt = rebuildDoc(doc, JSON_TYPE)
    expect(root(rebuilt).get('title')).toBeInstanceOf(Y.Text)
    expect(slide(rebuilt, 1)).toBeInstanceOf(Y.Text)
    expect(readText(rebuilt, JSON_TYPE)).toBe(readText(doc, JSON_TYPE))
  })

  it('utf8Length 与 UTF-8 编码的字节数一致(单字节、双字节、中文、emoji、落单的代理项)', () => {
    for (const s of ['', 'abc', 'é', '中文', '😀', 'a😀中é', '\ud800', 'x\udc00y']) {
      expect(utf8Length(s), JSON.stringify(s)).toBe(new TextEncoder().encode(s).byteLength)
    }
  })
})

describe('files content:spliceText(页面运行时写一段协同文本也用它)', () => {
  it('只换不同的那一段:旁边别人打的字留着,一样就什么都不做', () => {
    const doc = new Y.Doc()
    const text = doc.getText('t')
    text.insert(0, 'hello world')
    const ops: string[] = []
    text.observe((event) => ops.push(JSON.stringify(event.delta)))
    spliceText(text, 'hello brave world')
    expect(text.toString()).toBe('hello brave world')
    expect(ops).toEqual([JSON.stringify([{ retain: 6 }, { insert: 'brave ' }])])
    spliceText(text, 'hello brave world')
    expect(ops).toHaveLength(1)
  })

  it('不把代理对从中间劈开', () => {
    const doc = new Y.Doc()
    const text = doc.getText('t')
    text.insert(0, 'a😀b')
    spliceText(text, 'a😃b')
    expect(text.toString()).toBe('a😃b')
  })
})
