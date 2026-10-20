import {
  type CdnConfig, type FetchLike, type OssConfig, CDN_SIGN_TTL_SECONDS, MAX_ATTACHMENT_BYTES,
  cdnSignedUrl, ossCopy, ossDelete, ossExists, ossGetBytes, ossRequest, postObjectForm, refreshCdn,
} from './oss.ts'
import { type AttachmentObjectStorage, ObjectStorageError } from './object-storage.ts'

export function ossObjectStorage(config: { oss: OssConfig; cdn: CdnConfig; fetch: FetchLike }): AttachmentObjectStorage {
  const { oss, cdn, fetch } = config
  return {
    upload: (key, date) => postObjectForm(oss, { key, date, maxBytes: MAX_ATTACHMENT_BYTES }),
    read: (key, limit) => ossGetBytes(oss, fetch, key, { internal: true, limit }),
    promote: async (source, destination, read, headers) => {
      if (!read.etag) throw new Error('OSS promotion requires the source ETag')
      await ossCopy(oss, fetch, source, destination, read.etag, headers)
    },
    put: async (key, bytes) => {
      const response = await ossRequest(oss, fetch, { method: 'PUT', key, body: bytes as BodyInit, internal: true })
      if (response.status !== 200) throw new ObjectStorageError(response.status, null, 'Could not stage attachment bytes')
    },
    exists: (key) => ossExists(oss, fetch, key),
    remove: (key) => ossDelete(oss, fetch, key),
    sign: async (key, image, now) => cdnSignedUrl(cdn, key, { image, now }),
    invalidate: async (key, image) => { await refreshCdn(oss, fetch, cdn, key, image) },
  }
}

export interface SupabaseObjectConfig {
  url: string
  serviceKey: string
  bucket: string
  fetch: FetchLike
  signUpload(key: string): Promise<string>
  signDownload(key: string, seconds: number): Promise<string>
}

/** Stores the exact bytes read and hashed by the server; never re-copies mutable staging bytes. */
export function supabaseObjectStorage(config: SupabaseObjectConfig): AttachmentObjectStorage {
  const base = config.url.replace(/\/$/, '')
  const objectUrl = (key: string) => base + '/storage/v1/object/' + encodeURIComponent(config.bucket) + '/' + key.split('/').map(encodeURIComponent).join('/')
  const request = (url: string, init: RequestInit = {}) => config.fetch(url, {
    ...init, headers: { apikey: config.serviceKey, Authorization: 'Bearer ' + config.serviceKey, ...init.headers },
  })
  const check = async (response: Response) => {
    if (!response.ok) {
      let status = response.status
      if (status === 400) {
        // Storage may return HTTP 400 with a structured 404 for a missing object.
        const detail = await response.json().catch(() => null) as { statusCode?: string | number } | null
        if (Number(detail?.statusCode) === 404) status = 404
      } else await response.body?.cancel()
      throw new ObjectStorageError(status, null, 'Supabase attachment storage request failed')
    }
  }
  const write = async (key: string, bytes: Uint8Array, headers: Record<string, string> = {}) => {
    const response = await request(objectUrl(key), {
      method: 'POST', body: bytes as BodyInit,
      headers: { 'content-type': 'application/octet-stream', 'x-upsert': 'true', ...headers },
    })
    await check(response)
    await response.body?.cancel()
  }
  return {
    upload: async (key, now) => ({
      url: await config.signUpload(key), method: 'PUT', fields: {},
      expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    }),
    read: async (key, limit) => {
      const response = await request(objectUrl(key))
      await check(response)
      const declared = Number(response.headers.get('content-length'))
      if (declared > limit) {
        await response.body?.cancel()
        throw new ObjectStorageError(413, 'too_large', 'Attachment exceeds storage limit')
      }
      const reader = response.body?.getReader()
      const parts: Uint8Array[] = []
      let length = 0
      if (reader) {
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            length += next.value.byteLength
            if (length > limit) {
              await reader.cancel()
              throw new ObjectStorageError(413, 'too_large', 'Attachment exceeds storage limit')
            }
            parts.push(next.value)
          }
        } finally { reader.releaseLock() }
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
      return { bytes, etag: response.headers.get('etag') }
    },
    promote: async (_source, destination, read, headers) => write(destination, read.bytes, headers),
    put: (key, bytes) => write(key, bytes),
    exists: async (key) => {
      const response = await request(objectUrl(key), { method: 'HEAD' })
      try { await check(response) }
      catch (error) {
        if (error instanceof ObjectStorageError && error.status === 404) return false
        throw error
      }
      await response.body?.cancel()
      return true
    },
    remove: async (key) => {
      const response = await request(base + '/storage/v1/object/' + encodeURIComponent(config.bucket), {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: [key] }),
      })
      await check(response)
      await response.body?.cancel()
    },
    sign: async (key, _image, now) => ({
      url: await config.signDownload(key, CDN_SIGN_TTL_SECONDS), thumbUrl: null,
      expiresAt: new Date(now.getTime() + CDN_SIGN_TTL_SECONDS * 1000).toISOString(),
    }),
    invalidate: async () => { /* Supabase signed reads expire; no external CDN purge is configured. */ },
  }
}
