import { WORKSPACE_TEXT_MAX_BYTES, workspaceUploadKind } from 'https://raw.githubusercontent.com/OpenDCAI/gugu/fa542adee2b424a515b12a3e2b10bbf93c43d452/packages/core/src/shared/workspaceUpload.mjs'
import { handleCommit, handlePlace, type AttachmentsDeps } from '../../supabase/functions/_shared/attachments-core.ts'
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

Deno.test('old-data conversion resumes from its last completed cursor and repeated conversion is harmless', async () => {
  const f = fixture(encode(text))
  const rows = Array.from({ length: 21 }, (_, n) => ({ id: `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
    version: 1, blob_id: `blob-${n}`, filename: 'old.md', content_type: 'text/markdown', bucket_id: 'oss',
    object_name: 'original-object', size_bytes: encode(text).length, sha256: null }))
  const imported = new Set<string>()
  f.deps.serviceRpc = async (fn, args) => {
    f.calls.push({ fn, args })
    if (fn === 'workspace_document_import_candidates') return { data: rows.filter(row => row.id > String(args.p_after ?? '')).slice(0, 20), error: null }
    const id = String(args.p_item), changed = !imported.has(id)
    imported.add(id)
    return { data: changed, error: null }
  }
  const first = await handleDocumentImport(f.deps, {})
  assert(first.scanned === 20 && first.imported === 20 && !first.done, 'first completed batch provides a durable caller cursor')
  const resumed = await handleDocumentImport(f.deps, { after: first.after })
  assert(resumed.scanned === 1 && resumed.imported === 1 && resumed.done, 'resume processes the remaining file')
  const repeated = await handleDocumentImport(f.deps, {})
  assert(repeated.imported === 0 && imported.size === 21, 'repeating an already completed conversion changes nothing')
})
