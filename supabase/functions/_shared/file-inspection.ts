import { createHash } from 'node:crypto'
import { ObjectStorageError } from './object-storage.ts'

/** Hash while consuming a bounded stream; retain only a sniffing prefix, not the entire file. */
export async function inspectFileStream(body: ReadableStream<Uint8Array>, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid inspection limit')
  const reader = body.getReader()
  const hash = createHash('sha256')
  const prefix = new Uint8Array(512)
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
