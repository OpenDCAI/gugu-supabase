import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { buildDoc, rebuildDoc } from '../../../packages/files-core/src/content.mjs'
import { publicationOperation, publicationRpc, publishDocument } from '../../../services/files/src/publication.mjs'

const itemId = '11111111-1111-4111-8111-111111111111'
const operation = { fn: 'attachment_commit', args: { p_item_id: itemId, p_sender_user_id: 'actor', p_expected_version: 1, p_staging_key: 'staging/user/key' } }
afterEach(() => vi.unstubAllGlobals())

function fixture(text = 'original') {
  const document = buildDoc('text/markdown', text)
  let retired = false
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('files_publication_input')) return { rows: [{ input: { epoch: 0, text: 'original', document: { content_type: 'text/markdown', text: 'edited' } } }] }
    if (sql.includes('files_abort_publication')) return { rows: [{ epoch: null }] }
    return { rows: [] }
  })
  return { document, retired: () => retired, query, args: {
    pool: { query }, files: { swapGeneration: async (_name: string, _doc: Y.Doc, persist: (copy: Y.Doc) => Promise<number>) => {
      const copy = rebuildDoc(document, 'text/markdown')
      try { const result = await persist(copy); retired = true; return result } finally { copy.destroy() }
    } }, document, name: itemId + '@0', itemId, identity: { userId: 'user' }, grant: { actorId: 'actor', epoch: 0, contentType: 'text/markdown' }, operation,
  } }
}

describe('document publication keeps the original transaction and generation contract', () => {
  it('allows only the existing transaction and its authorized document target', () => {
    expect(publicationOperation(itemId, { publication: operation }, 'actor')).toBe(operation)
    for (const publication of [ { ...operation, fn: 'arbitrary_sql' }, { ...operation, args: { ...operation.args, p_item_id: 'other' } },
      { ...operation, args: { ...operation.args, p_sender_user_id: 'other' } }, { ...operation, args: { ...operation.args, p_expected_version: null } } ]) {
      expect(() => publicationOperation(itemId, { publication }, 'actor')).toThrow('bad-request')
    }
  })
  it('uses the caller Authorization and public API key, with the same original operation arguments', async () => {
    const fetch = vi.fn(async () => new Response('[{"id":"message"}]', { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    expect(await publicationRpc({ supabaseUrl: 'https://api.example', anonKey: 'public-api-key' }, 'Bearer original-caller', operation)).toEqual([{ id: 'message' }])
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.example/rest/v1/rpc/attachment_commit')
    expect(new Headers(options.headers).get('authorization')).toBe('Bearer original-caller')
    expect(new Headers(options.headers).get('apikey')).toBe('public-api-key')
    expect(JSON.parse(options.body as string)).toEqual(operation.args)
  })
  it('rejects unsaved concurrent edits before preparation or message commit', async () => {
    const f = fixture('unsaved concurrent text')
    const commit = vi.fn()
    await expect(publishDocument({ ...f.args, commit })).rejects.toThrow('content-changed')
    expect(commit).not.toHaveBeenCalled()
    expect(f.query.mock.calls.some(([sql]) => sql.includes('files_prepare_publication'))).toBe(false)
    expect(f.retired()).toBe(false)
    f.document.destroy()
  })
  it('revokes an unused preparation after a failed transaction, so delayed commit cannot overwrite resumed edits', async () => {
    const f = fixture()
    await expect(publishDocument({ ...f.args, commit: async () => { throw new Error('message rejected') } })).rejects.toThrow('message rejected')
    expect(f.query.mock.calls.map(([sql]) => sql.match(/chat\.(\w+)/)![1])).toEqual(['files_publication_input', 'files_prepare_publication', 'files_abort_publication'])
    expect(f.retired()).toBe(false)
    f.document.destroy()
  })
  it('a committed receipt with a lost reply retires the old generation and still fails the HTTP request', async () => {
    const f = fixture()
    const query = f.query.getMockImplementation()!
    f.query.mockImplementation(async (sql) => sql.includes('files_abort_publication') ? { rows: [{ epoch: 1 }] } : query(sql))
    await expect(publishDocument({ ...f.args, commit: async () => { throw new Error('reply lost') } })).rejects.toThrow('reply lost')
    expect(f.retired()).toBe(true)
    f.document.destroy()
  })
})
