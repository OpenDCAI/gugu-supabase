import { type AttachmentsDeps, call, objectStorage, Refusal } from './attachments-core.ts'
import { inspectFileStream } from './file-inspection.ts'

/** Service-only, resumable migration. Existing items and their immutable byte versions keep their identities. */
export async function handleDocumentImport(deps: AttachmentsDeps, body: Record<string, unknown>) {
  const after = body.after ?? null
  if (after !== null && (typeof after !== 'string' || !/^[0-9a-f-]{36}$/i.test(after))) {
    throw new Refusal(400, 'invalid', 'after must be an item UUID')
  }
  const rows = await call(deps.serviceRpc, 'workspace_document_import_candidates', { p_after: after, p_limit: 20 }) as {
    id: string; version: number; blob_id: string; filename: string; content_type: string
    bucket_id: string; object_name: string; size_bytes: number | string; sha256: string | null
  }[]
  let imported = 0
  for (const row of rows) {
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
    if (document.kind !== 'document') continue
    if (await call(deps.serviceRpc, 'workspace_import_document', {
      p_item: row.id, p_version: row.version, p_blob: row.blob_id,
      p_document: { text: document.text, content_type: document.contentType },
    })) imported++
  }
  return { scanned: rows.length, imported, after: rows.at(-1)?.id ?? after, done: rows.length < 20 }
}
