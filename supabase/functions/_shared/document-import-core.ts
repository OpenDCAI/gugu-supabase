import { type AttachmentsDeps, call, objectStorage, Refusal } from './attachments-core.ts'
import { inspectFileStream } from './file-inspection.ts'
import { WORKSPACE_TEXT_MAX_BYTES, workspaceUploadKind as classifyWorkspaceUpload } from 'https://raw.githubusercontent.com/OpenDCAI/gugu/fa542adee2b424a515b12a3e2b10bbf93c43d452/packages/core/src/shared/workspaceUpload.mjs'

export { WORKSPACE_TEXT_MAX_BYTES }
export function workspaceUploadKind(...args: Parameters<typeof classifyWorkspaceUpload>) {
  const kind = classifyWorkspaceUpload(...args)
  return kind.kind === 'document' && !['text/markdown', 'text/plain'].includes(kind.contentType)
    ? { kind: 'file' as const, why: 'Only Markdown and plain text attachments are documents' } : kind
}

/** Service-only, resumable migration. Existing items and their immutable byte versions keep their identities. */
export async function handleDocumentImport(deps: AttachmentsDeps, body: Record<string, unknown>) {
  const after = body.after ?? null
  const types = body.content_types
  if (types !== undefined && (!Array.isArray(types) || !types.length || types.some(type => typeof type !== 'string'))) {
    throw new Refusal(400, 'invalid', 'content_types must be a nonempty array of MIME types')
  }
  if (after !== null && (typeof after !== 'string' || !/^[0-9a-f-]{36}$/i.test(after))) {
    throw new Refusal(400, 'invalid', 'after must be an item UUID')
  }
  const rows = await call(deps.serviceRpc, 'workspace_document_import_candidates', { p_after: after, p_limit: 20 }) as {
    id: string; version: number; blob_id: string; filename: string; content_type: string
    bucket_id: string; object_name: string; size_bytes: number | string; sha256: string | null
  }[]
  let imported = 0
  for (const row of rows) try {
    let read
    if (row.bucket_id === 'oss') {
      const store = objectStorage(deps)
      if (!store.inspect) throw new Refusal(503, 'not_configured', 'Object inspection is not configured')
      read = await store.inspect(row.object_name, deps.textFiles.maxBytes, deps.textFiles.maxBytes + 1)
    } else {
      const signed = await deps.storageSignedUrl(row.bucket_id, row.object_name, 60)
      const response = await deps.fetch(signed, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok || !response.body) throw new Refusal(response.status || 502, 'source_unavailable', 'Stored bytes could not be read')
      read = await inspectFileStream(response.body, deps.textFiles.maxBytes, deps.textFiles.maxBytes + 1)
    }
    if (row.sha256 !== null && read.sha256 !== row.sha256 || read.sizeBytes !== Number(row.size_bytes) || read.bytes.length !== read.sizeBytes) {
      throw new Refusal(409, 'source_changed', 'Stored bytes do not match the version being imported')
    }
    const document = deps.textFiles.classify(row.filename, row.content_type, read.bytes)
    if (document.kind !== 'document' || types && !types.includes(document.contentType)) continue
    if (await call(deps.serviceRpc, 'workspace_import_document', {
      p_item: row.id, p_version: row.version, p_blob: row.blob_id,
      p_document: { text: document.text, content_type: document.contentType },
    })) imported++
  } catch (error) {
    if (error instanceof Refusal) error.message = `item ${row.id}: ${error.message}`
    throw error
  }
  return { scanned: rows.length, imported, after: rows.at(-1)?.id ?? after, done: rows.length < 20 }
}
