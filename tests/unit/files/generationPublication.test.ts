import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

import { applyJson, buildDoc, readFileText, readText } from '../../../packages/files-core/src/content.mjs'
import { createOpenFiles } from '../../../packages/files-core/src/open-files.mjs'

function fixture(type = 'text/markdown', text = 'original') {
  const messages: unknown[] = []
  const closed: unknown[] = []
  const connection = { sendStateless: (message: string) => messages.push(JSON.parse(message)), close: (reason: unknown) => closed.push(reason) }
  const document = Object.assign(buildDoc(type, text), { getConnections: () => [connection] })
  const stats = { rateLimited: 0, tooLarge: 0, presenceCoalesced: 0, presenceFlushed: 0, concurrentMerges: { create: 0, lateWrite: 0 }, hotCompactions: 0, compactAborted: 0 }
  const files = createOpenFiles({ maxBytes: 1024, limits: { rateUpdates: { perSecond: 100, burst: 100 }, rateBytes: { perSecond: 1024, burst: 1024 }, rateAwareness: { perSecond: 1, burst: 1 } }, log: { warn: vi.fn() }, stats,
    compaction: { ratio: 8, minBytes: 256, cooldownMs: 0, drainMs: 1000 } })
  files.attach(document, 'file@0', { contentType: type })
  const drain = () => files.hooks.onStateless({ connection, documentName: 'file@0', payload: '{"t":"drained"}' })
  return { files, document, connection, messages, closed, drain, stats }
}

afterEach(() => vi.useRealTimers())

describe('the existing generation swap publishes an external document revision', () => {
  it('drains before copying, so an edit arriving during the drain is included in the conflict check', async () => {
    const f = fixture()
    const persist = vi.fn(async (copy: Y.Doc) => {
      if (readText(copy, 'text/markdown') !== 'original') throw new Error('content-changed')
      return 1
    })
    const published = f.files.swapGeneration('file@0', f.document, persist)
    const rejected = expect(published).rejects.toThrow('content-changed')
    expect(f.messages).toEqual([{ t: 'compact' }])
    expect(persist).not.toHaveBeenCalled()
    f.document.getText('content').insert(0, 'unsaved ')
    await f.drain()
    await rejected
    expect(readText(f.document, 'text/markdown')).toBe('unsaved original')
    expect(f.messages.at(-1)).toEqual({ t: 'resume' })
    expect(f.closed).toEqual([])
    expect(f.files.frozen('file@0')).toBe(false)
    f.document.destroy()
  })

  it('drain timeout never calls the transaction and resumes the original page', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = fixture()
    const persist = vi.fn(async () => 1)
    const rejected = expect(f.files.swapGeneration('file@0', f.document, persist)).rejects.toThrow('drain-timeout')
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(persist).not.toHaveBeenCalled()
    expect(f.messages).toEqual([{ t: 'compact' }, { t: 'resume' }])
    expect(readText(f.document, 'text/markdown')).toBe('original')
    f.document.destroy()
  })

  it('a failed transaction discards the copy and permits a later successful publication', async () => {
    const f = fixture()
    const rejected = expect(f.files.swapGeneration('file@0', f.document, async (copy) => {
      copy.getText('content').insert(0, 'failed ')
      throw new Error('transaction rolled back')
    })).rejects.toThrow('transaction rolled back')
    await f.drain()
    await rejected
    expect(readText(f.document, 'text/markdown')).toBe('original')
    const published = f.files.swapGeneration('file@0', f.document, async (copy) => {
      expect(readText(copy, 'text/markdown')).toBe('original')
      return 7
    })
    await f.drain()
    expect(await published).toBe(7)
    expect(f.closed).toEqual([{ code: 4409, reason: 'compacted:7' }])
    expect(f.stats.hotCompactions).toBe(0)
    expect(f.files.frozen('file@0')).toBe(true)
    f.document.destroy()
  })

  it('JSON publication keeps cooperative Y.Text types and their identity within the typed copy', async () => {
    const f = fixture('application/json', '{"text":{"$text":"before"},"list":[{"$text":"nested"}]}')
    const published = f.files.swapGeneration('file@0', f.document, async (copy) => {
      const text = copy.getMap('root').get('text')
      const list = copy.getMap('root').get('list') as Y.Array<Y.Text>
      const nested = list.get(0)
      applyJson(copy.getMap('root'), { text: 'after', list: ['changed'] })
      expect(copy.getMap('root').get('text')).toBe(text)
      expect(text).toBeInstanceOf(Y.Text)
      expect(list.get(0)).toBe(nested)
      expect(nested).toBeInstanceOf(Y.Text)
      expect(readText(copy, 'application/json')).toBe('{"text":"after","list":["changed"]}')
      const reopened = buildDoc('application/json', readFileText(copy, 'application/json'))
      expect(reopened.getMap('root').get('text')).toBeInstanceOf(Y.Text)
      expect((reopened.getMap('root').get('list') as Y.Array<Y.Text>).get(0)).toBeInstanceOf(Y.Text)
      expect(readText(reopened, 'application/json')).toBe(readText(copy, 'application/json'))
      reopened.destroy()
      return 1
    })
    await f.drain()
    expect(await published).toBe(1)
    expect(readText(f.document, 'application/json')).toBe('{"text":"before","list":["nested"]}')
    f.document.destroy()
  })
})
