import { WORKSPACE_TEXT_MAX_BYTES, workspaceUploadKind } from 'https://raw.githubusercontent.com/OpenDCAI/gugu/fa542adee2b424a515b12a3e2b10bbf93c43d452/packages/core/src/shared/workspaceUpload.mjs'
import { handleCommit, handlePlace, handleShare, type AttachmentsDeps } from '../../supabase/functions/_shared/attachments-core.ts'
import { inspectFileStream } from '../../supabase/functions/_shared/file-inspection.ts'
import { handleDocumentImport } from '../../supabase/functions/_shared/document-import-core.ts'

const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
const user = '11111111-1111-4111-8111-111111111111'
const key = `staging/${user}/22222222-2222-4222-8222-222222222222`
const text = '# 同一份正文\n' + '非 ASCII 内容在 512 字节之后仍完整。\n'.repeat(80)
const encode = (text: string) => new TextEncoder().encode(text)

function fixture(bytes: Uint8Array) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  const deps = {
    textFiles: { maxBytes: WORKSPACE_TEXT_MAX_BYTES, classify: workspaceUploadKind },
    objects: {
      inspect: async (_key: string, limit: number, retain: number) => ({
        ...await inspectFileStream(new ReadableStream({ start(c) {
          c.enqueue(bytes.subarray(0,511)); c.enqueue(bytes.subarray(511)); c.close()
        }}), limit, retain), etag: '"immutable"',
      }),
      promote: async () => {}, exists: async () => true,
    },
    serviceRpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      return { data: fn === 'file_managed_upload_for' ? { max_bytes: bytes.length } : [{ created: false }], error: null }
    },
    userRpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args }); return { data: [{ id: 'result' }], error: null }
    },
  } as unknown as AttachmentsDeps
  return { deps, calls }
}

Deno.test('human attachment, agent attachment and folder upload register the same complete document', async () => {
  for (const entry of ['human', 'agent', 'folder']) {
    const f = fixture(encode(text))
    const body = { staging_key: key, file_name: '中文.md', content_type: 'application/octet-stream',
      chat_id: 'group', sender_user_id: entry === 'agent' ? 'agent' : user }
    if (entry === 'folder') await handlePlace(f.deps, user, body)
    else await handleCommit(f.deps, user, { ...body, message_id: 'message' })
    const registered = f.calls.find(c => c.fn === 'file_managed_upload_registered')!
    const document = registered.args.p_document as { text: string; content_type: string }
    assert(document.text === text, `${entry} retains the entire text`)
    assert(document.content_type === 'text/markdown', `${entry} uses the canonical suffix rule`)
    assert(f.calls.filter(c => c.fn === 'file_blob_register').length === 1, `${entry} uses one blob registration`)
    assert(f.calls.findIndex(c => c.fn === 'file_managed_upload_scope') === 0, `${entry} authorizes before inspection`)
  }
})

Deno.test('binary, malformed UTF-8/JSON and over-limit text keep the original binary admission', async () => {
  for (const [name, type, bytes] of [
    ['real.bin', 'application/octet-stream', new Uint8Array([0xff, 0x00, 0x80])],
    ['broken.md', 'text/markdown', new Uint8Array([0xff, 0xfe])],
    ['array.json', 'application/json', encode('[]')],
    ['large.md', 'text/markdown', new Uint8Array(WORKSPACE_TEXT_MAX_BYTES + 2).fill(65)],
  ] as const) {
    const f = fixture(bytes)
    await handlePlace(f.deps, user, { staging_key: key, chat_id: 'group', file_name: name, content_type: type })
    assert(f.calls.find(c => c.fn === 'file_managed_upload_registered')!.args.p_document === null, name)
    assert(f.calls.some(c => c.fn === 'file_place_as'), `${name} still uses ordinary file placement`)
  }
})

Deno.test('a storage adapter returning only its sniffing prefix cannot silently truncate a document', async () => {
  const f = fixture(encode(text))
  f.deps.objects!.inspect = async () => ({ bytes: encode(text).subarray(0,512), sizeBytes: encode(text).length,
    sha256: 'a'.repeat(64), etag: '"immutable"' })
  let refused = false
  try { await handlePlace(f.deps, user, { staging_key: key, chat_id: 'group', file_name: '正文.md' }) }
  catch (error) { refused = (error as { code?: string }).code === 'not_configured' }
  assert(refused, 'partial inspection fails before registration or placement')
  assert(!f.calls.some(c => c.fn === 'file_blob_register' || c.fn === 'file_place_as'), 'no truncated bytes were admitted')
})

function shareFixture(options: { version?: number; replay?: boolean } = {}) {
  const f = fixture(encode(text)), published: unknown[] = [], puts: Uint8Array[] = []
  const message = '22222222-2222-4222-8222-222222222222'
  const body = { item_id: '33333333-3333-4333-8333-333333333333', chat_id: 'target', sender_user_id: user, message_id: message }
  f.deps.userRpc = async (fn, args) => {
    f.calls.push({ fn, args })
    if (fn === 'workspace_get_as') return { data: [{ kind: 'document', version: options.version ?? 1, chat_id: 'source' }], error: null }
    if (fn === 'file_managed_upload_prepare') return { data: { max_bytes: WORKSPACE_TEXT_MAX_BYTES, permit_seconds: 900 }, error: null }
    if (fn === 'file_managed_upload_as') return { data: { staging_key: key, signed_at: '2026-10-27T01:00:00Z', expires_at: '2026-10-27T01:15:00Z', max_bytes: WORKSPACE_TEXT_MAX_BYTES }, error: null }
    return { data: [{ id: 'sent' }], error: null }
  }
  f.deps.serviceRpc = async (fn, args) => {
    f.calls.push({ fn, args })
    if (fn === 'file_managed_upload_for') return { data: args.p_optional
      ? options.replay ? { blob_id: 'blob', document: { prepared: { expected_version: 1 } } } : null
      : { max_bytes: WORKSPACE_TEXT_MAX_BYTES, blob_id: null }, error: null }
    return { data: [{ created: false }], error: null }
  }
  f.deps.objects!.uploadBounds = async (bytes, seconds) => ({ maxBytes: bytes, expiresSeconds: seconds })
  f.deps.objects!.upload = async () => ({ url: 'https://upload.invalid', fields: {}, expiresAt: '2026-10-27T01:15:00Z' })
  f.deps.objects!.put = async (_key, bytes) => { puts.push(bytes) }
  f.deps.readDocument = async () => { f.calls.push({ fn: 'readDocument', args: {} }); return { text, contentType: 'text/markdown', version: 1, name: '正文.md' } }
  f.deps.publishDocument = async (_item, operation) => { published.push(operation); return [{ id: 'sent' }] }
  return { ...f, body, published, puts }
}

Deno.test('sharing a current document uses the same inspected upload and original share transaction', async () => {
  const f = shareFixture()
  assert((await handleShare(f.deps, user, f.body) as { id: string }).id === 'sent', 'message returned')
  assert(f.puts.length === 1 && new TextDecoder().decode(f.puts[0]) === text, 'the editor exports complete file bytes')
  const operation = f.published[0] as { fn: string; args: Record<string, unknown>; snapshot: boolean }
  assert(operation.fn === 'attachment_share' && operation.snapshot, 'same original share transaction')
  assert(operation.args.p_version === 1 && operation.args.p_staging_key === key, 'source version and existing receipt are bound')
  const registered = f.calls.find(c => c.fn === 'file_managed_upload_registered')!
  assert((registered.args.p_document as { text: string }).text === text, 'canonical inspected document')
})

Deno.test('a historical share with immutable bytes does not start a new editor publication', async () => {
  const f = shareFixture({ version: 2 })
  await handleShare(f.deps, user, { ...f.body, version: 1 })
  assert(f.calls.some(c => c.fn === 'attachment_share' && c.args.p_version === 1), 'same historical version')
  assert(f.published.length === 0 && f.puts.length === 0 && !f.calls.some(c => c.fn === 'readDocument'), 'no replacement or export')
})

Deno.test('a lost share reply replays the original prepared version after the head has advanced', async () => {
  const f = shareFixture({ version: 9, replay: true })
  await handleShare(f.deps, user, { ...f.body, version: 1 })
  const operation = f.published[0] as { args: Record<string, unknown> }
  assert(operation.args.p_version === 1, 'the receipt retains the original source version')
  assert(f.puts.length === 0 && !f.calls.some(c => c.fn === 'readDocument'), 'no rewritten bytes or second editor')
})

Deno.test('old OSS and legacy storage files migrate in place through the same classifier without changing the blob or version', async () => {
  for (const bucket of ['oss', 'workspace']) {
    const f = fixture(encode(text))
    f.deps.storageSignedUrl = async (actual, object) => {
      assert(actual === bucket && object === 'old-object', 'the original storage location is used')
      return 'https://legacy.invalid/old-object'
    }
    f.deps.fetch = async () => new Response(encode(text))
    f.deps.serviceRpc = async (fn, args) => {
      f.calls.push({ fn, args })
      return { data: fn === 'workspace_document_import_candidates' ? [{ id: user, version: 7, blob_id: 'original-blob',
        filename: '旧附件.md', content_type: 'text/markdown', bucket_id: bucket, object_name: 'old-object',
        size_bytes: encode(text).length, sha256: null }] : true, error: null }
    }
    const result = await handleDocumentImport(f.deps, {})
    assert(result.imported === 1 && result.done, 'one in-place conversion')
    const imported = f.calls.find(c => c.fn === 'workspace_import_document')!
    assert(imported.args.p_item === user && imported.args.p_version === 7 && imported.args.p_blob === 'original-blob', 'identity, version and immutable bytes remain the same')
    assert((imported.args.p_document as { text: string }).text === text, 'complete text reaches the existing document model')
  }
})

Deno.test('old-data conversion refuses mismatched stored bytes before changing the item', async () => {
  const f = fixture(encode(text))
  f.deps.serviceRpc = async (fn, args) => {
    f.calls.push({ fn, args })
    return { data: [{ id: user, version: 7, blob_id: 'blob', filename: 'old.md', bucket_id: 'oss',
      object_name: 'old', size_bytes: 1, sha256: null }], error: null }
  }
  let refused = false
  try { await handleDocumentImport(f.deps, {}) } catch (error) { refused = (error as { code?: string }).code === 'source_changed' }
  assert(refused && !f.calls.some(c => c.fn === 'workspace_import_document'), 'immutable source is checked before conversion')
})
