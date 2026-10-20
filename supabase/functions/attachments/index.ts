// Community attachments: user-owned Supabase Storage; user/RLS and GC authorization are enforced below.
import { createClient } from 'npm:@supabase/supabase-js@2.110.9'
import {
  type AttachmentsDeps,
  handleCommit,
  handlePlace,
  handleForward,
  handleGc,
  handleUpload,
  handleUrls,
  Refusal,
} from '../_shared/attachments-core.ts'

import { supabaseObjectStorage } from '../_shared/attachment-object-storage.ts'

const env = (key: string): string => Deno.env.get(key)?.trim() ?? ''

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

function log(stage: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ fn: 'attachments', stage, ...extra }))
}

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']

/** 两段一样长才比内容,逐字节异或:比较的时间不随第一个不同的位置变。 */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  if (x.length !== y.length || x.length === 0) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!
  return diff === 0
}

function publicStorageUrl(signedUrl: string, internalBase: string): string {
  const internal = internalBase.replace(/\/$/, '')
  if (!signedUrl.startsWith(internal + '/')) throw new Error('Unexpected storage URL origin')
  const external = (env('GUGU_PUBLIC_SUPABASE_URL') || internal).replace(/\/$/, '')
  return external + signedUrl.slice(internal.length)
}

function depsFor(authorization: string): AttachmentsDeps {
  const url = env('SUPABASE_URL')
  const asUser = createClient(url, env('SUPABASE_ANON_KEY'), {
    db: { schema: 'chat' },
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const asService = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), { db: { schema: 'chat' }, auth: { persistSession: false } })
  return {
    objects: supabaseObjectStorage({
      url, serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'), bucket: env('GUGU_ATTACHMENTS_BUCKET') || 'attachments',
      fetch: (input, init) => fetch(input, init),
      signUpload: async (key) => {
        const { data, error } = await asService.storage.from(env('GUGU_ATTACHMENTS_BUCKET') || 'attachments').createSignedUploadUrl(key)
        if (error || !data?.signedUrl) throw new Error('could not sign attachment upload')
        return publicStorageUrl(data.signedUrl, url)
      },
      signDownload: async (key, seconds) => {
        const { data, error } = await asService.storage.from(env('GUGU_ATTACHMENTS_BUCKET') || 'attachments').createSignedUrl(key, seconds)
        if (error || !data?.signedUrl) throw new Error('could not sign attachment download')
        return publicStorageUrl(data.signedUrl, url)
      },
    }),
    fetch: (input, init) => fetch(input, init),
    userRpc: async (fn, args) => {
      const { data, error } = await asUser.rpc(fn, args)
      return { data, error: error ? { message: error.message, hint: error.hint, code: error.code } : null }
    },
    serviceRpc: async (fn, args) => {
      const { data, error } = await asService.rpc(fn, args)
      return { data, error: error ? { message: error.message, hint: error.hint, code: error.code } : null }
    },
    storageSignedUrl: async (bucket, object, seconds) => {
      const { data, error } = await asService.storage.from(bucket).createSignedUrl(object, seconds)
      if (error || !data?.signedUrl) throw new Refusal(500, 'failed', `could not sign ${bucket}/${object}: ${error?.message ?? 'no url'}`)
      return publicStorageUrl(data.signedUrl, url)
    },
    storageRemove: async (bucket, object) => {
      const { error } = await asService.storage.from(bucket).remove([object])
      if (error) throw new Error(`could not remove ${bucket}/${object}: ${error.message}`)
    },
    now: () => new Date(),
    uuid: () => crypto.randomUUID(),
    log,
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (request.method !== 'POST') return json({ error: 'invalid', message: 'POST only' }, 405)
  const missing = REQUIRED.filter((key) => !env(key))
  if (missing.length) {
    log('not_configured', { missing })
    return json({ error: 'not_configured', message: `attachments storage is not configured: ${missing.join(', ')}` }, 503)
  }
  const route = new URL(request.url).pathname.split('/').filter(Boolean).at(-1) ?? ''
  const authorization = request.headers.get('Authorization') ?? ''
  try {
    const deps = depsFor(authorization)
    if (route === 'gc') {
      if (!sameSecret(authorization.replace(/^Bearer\s+/i, ''), env('SUPABASE_SERVICE_ROLE_KEY'))) {
        return json({ error: 'denied', message: 'gc is the server\'s own job' }, 401)
      }
      const result = await handleGc(deps)
      const service = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { db: { schema: 'chat' }, auth: { persistSession: false } })
      const bucket = env('GUGU_ATTACHMENTS_BUCKET') || 'attachments'
      const { data: expired, error: expiredError } = await service.rpc('attachment_expired_staging', { p_bucket: bucket })
      if (expiredError) throw new Error('Could not list expired staging uploads')
      const names = ((expired ?? []) as Array<{ name: string }>).map((row) => row.name)
      if (names.length) {
        const { error } = await service.storage.from(bucket).remove(names)
        if (error) throw new Error('Could not remove expired staging uploads')
      }
      return json({ ...result, staging_deleted: names.length })
    }
    const asUser = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: who, error: whoError } = await asUser.auth.getUser()
    if (whoError || !who?.user?.id) return json({ error: 'denied', message: 'sign in first' }, 401)
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    switch (route) {
      case 'upload':
        return json(await handleUpload(deps, who.user.id))
      case 'commit':
        return json({ message: await handleCommit(deps, who.user.id, body) })
      case 'place':
        return json({ item: await handlePlace(deps, who.user.id, body) })
      case 'forward':
        return json({ message: await handleForward(deps, who.user.id, body) })
      case 'urls':
        return json(await handleUrls(deps, who.user.id, body))
      default:
        return json({ error: 'invalid', message: `no route ${route}` }, 404)
    }
  } catch (error) {
    if (error instanceof Refusal) return json({ error: error.code, message: error.message }, error.status)
    log('failed', { route, error: String(error) })
    return json({ error: 'failed', message: 'attachments failed; try again' }, 500)
  }
})
