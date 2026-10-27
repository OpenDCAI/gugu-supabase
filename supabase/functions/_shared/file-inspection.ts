import { createHash } from 'node:crypto'
import { ObjectStorageError } from './object-storage.ts'

/** Hash the full bounded stream, retaining only the bytes the caller needs to inspect. */
export async function inspectFileStream(body: ReadableStream<Uint8Array>, limit: number, retainBytes = 512) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid inspection limit')
  if (!Number.isSafeInteger(retainBytes) || retainBytes < 512) throw new Error('Invalid inspection prefix size')
  const reader = body.getReader()
  const hash = createHash('sha256')
  const prefix = new Uint8Array(Math.min(limit, retainBytes))
  let sizeBytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (sizeBytes + value.byteLength > limit) {
        await reader.cancel()
        throw new ObjectStorageError(413, 'too_large', 'File exceeds its upload reservation')
      }
      if (sizeBytes < prefix.length) prefix.set(value.subarray(0, prefix.length - sizeBytes), sizeBytes)
      sizeBytes += value.byteLength
      hash.update(value)
    }
    return { sizeBytes, sha256: hash.digest('hex'),
      bytes: prefix.subarray(0, Math.min(sizeBytes, prefix.length)) }
  } finally { reader.releaseLock() }
}
