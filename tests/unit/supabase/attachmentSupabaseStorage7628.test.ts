import { createHash } from 'node:crypto'
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
  it('reports the real bucket ceiling and fixed signed-upload lifetime instead of promising per-object enforcement',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({file_size_limit:26214400})))
    expect(await storage(fetcher).uploadBounds(5,120)).toEqual({maxBytes:26214400,expiresSeconds:7200})
    expect(fetcher.mock.calls[0]![0]).toBe('https://project.example/storage/v1/bucket/attachments')
    for (const size of [null,0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'Infinity','invalid']) {
      await expect(storage(vi.fn(async()=>new Response(JSON.stringify({file_size_limit:size})))).uploadBounds(5,120))
        .rejects.toMatchObject({status:503,code:'not_configured'})
    }
  })
  it('accepts a finite ceiling covering 25 MiB plaintext plus authentication frames and refuses one byte beyond it',async()=>{
    const plaintext=25*1024*1024,ceiling=32+plaintext+Math.ceil(plaintext/(256*1024))*17
    expect(ceiling).toBe(26216132)
    const api=storage(vi.fn(async()=>new Response(JSON.stringify({file_size_limit:String(ceiling)}))))
    expect(await api.uploadBounds(ceiling,7200)).toEqual({maxBytes:ceiling,expiresSeconds:7200})
    await expect(api.uploadBounds(ceiling+1,7200)).rejects.toMatchObject({status:503,code:'not_configured'})
  })
  it('inspects the entire authenticated representation at its exact granted ceiling and refuses one byte less',async()=>{
    const plaintext=25*1024*1024,ceiling=32+plaintext+Math.ceil(plaintext/(256*1024))*17
    const bytes=new Uint8Array(ceiling).fill(17),api=storage(vi.fn(async()=>new Response(bytes)))
    const inspected=await api.inspect('temporary/encrypted',ceiling)
    expect(inspected.sizeBytes).toBe(ceiling)
    expect(inspected.bytes.byteLength).toBe(ceiling)
    expect(inspected.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    await expect(api.inspect('temporary/encrypted',ceiling-1)).rejects.toMatchObject({status:413,code:'too_large'})
  })

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

  it('sends a single Content-Type when promoting with object headers', async () => {
    let sent: Headers | undefined
    const api = storage(vi.fn(async (_url, init) => {
      if (init?.method === 'POST') { sent = new Headers(init.headers); return new Response('{}') }
      return new Response(new Uint8Array([1]))
    }))
    const read = await api.read('staging/u/file', 10)
    await api.promote('staging/u/file', 'ab/hash', read, { 'Content-Type': 'image/png', 'Cache-Control': 'immutable' })
    expect(sent?.get('content-type')).toBe('image/png')
    expect(sent?.get('x-upsert')).toBe('true')
    expect(sent?.get('authorization')).toBe('Bearer server-only-fixture')
  })
})
