import { describe, expect, it, vi } from 'vitest'
import { supabaseObjectStorage } from '../../../supabase/functions/_shared/attachment-object-storage'
import { ObjectStorageError } from '../../../supabase/functions/_shared/object-storage'

function storage(fetcher: typeof fetch) {
  return supabaseObjectStorage({
    url: 'https://project.example', serviceKey: 'server-only-fixture', bucket: 'attachments',
    fetch: fetcher,
    signUpload: async () => 'https://project.example/storage/v1/object/upload/sign/attachments/staging?token=scoped',
    signDownload: async () => 'https://project.example/signed/object',
  })
}

describe('community attachment storage', () => {
  it('promotes exactly the hashed bytes even when staging changes after the read', async () => {
    let staged = new Uint8Array([1, 2, 3])
    let stored: Uint8Array | undefined
    const api = storage(vi.fn(async (_url, init) => {
      if (init?.method === 'POST') {
        stored = new Uint8Array(await new Response(init.body).arrayBuffer())
        return new Response('{}')
      }
      return new Response(staged)
    }))
    const read = await api.read('staging/u/file', 10)
    staged = new Uint8Array([9, 9, 9])
    await api.promote('staging/u/file', 'ab/hash', read, {})
    expect(stored).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('cancels a chunked response once it exceeds the attachment limit', async () => {
    let cancelled = false
    const api = storage(vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(4))
        controller.enqueue(new Uint8Array(4))
      },
      cancel() { cancelled = true },
    }))))
    await expect(api.read('staging/u/file', 5)).rejects.toMatchObject({ status: 413 })
    expect(cancelled).toBe(true)
  })

  it('recognizes structured missing-object errors and preserves authentication errors', async () => {
    const missing = storage(vi.fn(async () => new Response('{"statusCode":"404"}', { status: 400 })))
    await expect(missing.read('staging/u/file', 10)).rejects.toMatchObject({ status: 404 })
    const denied = storage(vi.fn(async () => new Response('{}', { status: 401 })))
    await expect(denied.exists('ab/hash')).rejects.toBeInstanceOf(ObjectStorageError)
  })

  it('returns only a scoped upload URL and never the server credential', async () => {
    const plan = await storage(vi.fn()).upload('staging/u/file', new Date('2026-10-21T00:00:00Z'))
    expect(plan.method).toBe('PUT')
    expect(JSON.stringify(plan)).not.toContain('server-only-fixture')
    expect(plan.url).toContain('token=scoped')
  })
})
