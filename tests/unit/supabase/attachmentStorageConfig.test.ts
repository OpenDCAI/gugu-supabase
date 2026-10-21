// Which object store the attachments function talks to is decided by environment variables alone:
// none set → Supabase Storage (community default), all set → OSS + CDN, anything in between → refuse.
import { describe, expect, it } from 'vitest'
import { attachmentStorageConfig, OSS_ENV, StorageConfigError } from '../../../supabase/functions/_shared/attachment-storage-config'
import { ossObjectStorage } from '../../../supabase/functions/_shared/attachment-object-storage'
import { type AttachmentsDeps, handleUrls } from '../../../supabase/functions/_shared/attachments-core'

const OSS: Record<string, string> = {
  OSS_REGION: 'cn-wulanchabu',
  OSS_BUCKET: 'files-test',
  OSS_ENDPOINT_INTERNAL: 'oss-cn-wulanchabu-internal.aliyuncs.com',
  OSS_ENDPOINT_PUBLIC: 'oss-cn-wulanchabu.aliyuncs.com',
  OSS_ACCESS_KEY_ID: 'fixture-access-id',
  OSS_ACCESS_KEY_SECRET: 'fixture-secret-never-in-output',
  CDN_DOMAIN: 'files.example.test',
  CDN_AUTH_KEY_PRIMARY: 'fixture-cdn-key-never-in-output',
}
const from = (vars: Record<string, string>) => (key: string) => vars[key]

describe('attachment storage configuration', () => {
  it('defaults to the project Supabase Storage bucket when no OSS variable is set', () => {
    expect(attachmentStorageConfig(from({}))).toEqual({ kind: 'supabase', bucket: 'attachments' })
    expect(attachmentStorageConfig(from({ GUGU_ATTACHMENTS_BUCKET: ' files ' }))).toEqual({ kind: 'supabase', bucket: 'files' })
  })

  it('uses OSS with CDN-signed reads when every OSS variable is set', () => {
    const config = attachmentStorageConfig(from({ ...OSS, ATTACHMENTS_OBJECT_PREFIX: 'devdb' }))
    expect(config).toEqual({
      kind: 'oss',
      oss: {
        objectPrefix: 'devdb', region: 'cn-wulanchabu', bucket: 'files-test',
        endpointInternal: 'oss-cn-wulanchabu-internal.aliyuncs.com', endpointPublic: 'oss-cn-wulanchabu.aliyuncs.com',
        accessKeyId: 'fixture-access-id', accessKeySecret: 'fixture-secret-never-in-output',
      },
      cdn: { domain: 'files.example.test', authKey: 'fixture-cdn-key-never-in-output', objectPrefix: 'devdb' },
    })
  })

  it('refuses a partial OSS configuration and names exactly what is missing', () => {
    for (const dropped of OSS_ENV) {
      const vars = { ...OSS, [dropped]: '  ' }
      expect(() => attachmentStorageConfig(from(vars))).toThrow(StorageConfigError)
      try { attachmentStorageConfig(from(vars)) } catch (error) { expect((error as StorageConfigError).missing).toEqual([dropped]) }
    }
    expect(() => attachmentStorageConfig(from({ OSS_BUCKET: 'only-one' }))).toThrow(/missing OSS_REGION/)
  })

  it('hands OSS uploads out as a signed post form without any credential', async () => {
    const config = attachmentStorageConfig(from({ ...OSS, ATTACHMENTS_OBJECT_PREFIX: 'devdb' }))
    if (config.kind !== 'oss') throw new Error('expected OSS')
    const objects = ossObjectStorage({ oss: config.oss, cdn: config.cdn, fetch: async () => new Response(null, { status: 500 }) })
    const form = await objects.upload('staging/user/one', new Date('2026-10-21T00:00:00Z'))
    expect(form.url).toBe('https://files-test.oss-cn-wulanchabu.aliyuncs.com/')
    expect(form.fields.key).toBe('devdb/staging/user/one')
    expect(JSON.stringify(form)).not.toContain('fixture-secret-never-in-output')
    expect(JSON.stringify(form)).not.toContain('fixture-cdn-key-never-in-output')
  })

  it('reads attachments already stored on OSS through CDN links', async () => {
    const config = attachmentStorageConfig(from(OSS))
    if (config.kind !== 'oss') throw new Error('expected OSS')
    const row = {
      item_id: null, version: null, message_id: 'm1', current_version: null, chat_id: 'c1', file_name: 'a.png',
      bucket_id: 'oss', object_name: 'ab/abcdef', sha256: 'abcdef', size_bytes: 3, content_type: 'image/png', width: 1, height: 1,
    }
    const deps = {
      objects: ossObjectStorage({ oss: config.oss, cdn: config.cdn, fetch: async () => new Response(null, { status: 500 }) }),
      userRpc: async (fn: string) => ({ data: fn === 'file_urls_as' ? [row] : null, error: null }),
      storageSignedUrl: async () => { throw new Error('OSS rows must not be signed by Supabase Storage') },
      now: () => new Date('2026-10-21T00:00:00Z'),
    } as unknown as AttachmentsDeps
    const { urls } = await handleUrls(deps, 'u1', { refs: [{ message_id: 'm1' }] })
    expect(urls).toHaveLength(1)
    expect(urls[0]!.url).toMatch(/^https:\/\/files\.example\.test\/ab\/abcdef\?auth_key=/)
    expect(urls[0]!.thumb_url).toContain('x-oss-process=')
  })
})
