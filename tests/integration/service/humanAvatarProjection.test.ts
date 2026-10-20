import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// 连接信息只读环境变量(本地起库后用 `pnpm dev:db env` 导出);本仓 vitest 不注入假 Supabase env。
const envOf = (key: string) => (process.env[key] ?? '').trim()
const URL_ = envOf('VITE_SUPABASE_URL')
const SERVICE_KEY = envOf('SUPABASE_SERVICE_ROLE_KEY')
const RUN = `fxavatar${Date.now().toString(36)}`
const PASSWORD = 'GuguAvatar-fixture-pw1' // gitleaks:allow -- fixture password for disposable loopback Auth users
const VALID_AVATAR = 'https://cdn.example.test/avatars/human-explicit.png'

const CASES = [
  { key: 'missing', metadata: { nickname: 'Missing Avatar' }, expectedAvatar: null },
  {
    key: 'classic',
    metadata: {
      nickname: 'Classic Avatar',
      avatar_url: './assets/user-avatars/avatar-01.svg',
      keep: 'classic-sentinel'
    },
    expectedAvatar: null
  },
  {
    key: 'invalid',
    metadata: {
      nickname: 'Invalid Avatar',
      avatar_url: 'javascript:alert(1)',
      keep: 'invalid-sentinel'
    },
    expectedAvatar: null
  },
  {
    key: 'valid',
    metadata: { nickname: 'Valid Avatar', avatar_url: VALID_AVATAR, keep: 'valid-sentinel' },
    expectedAvatar: VALID_AVATAR
  }
] as const

let identityDb: SupabaseClient
let adminAuth: SupabaseClient
let cleanupReady = false
const created: Array<{ id: string; email: string }> = []

function assertDevOnly(): void {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URL_)) {
    throw new Error(
      `humanAvatarProjection.test only accepts loopback dev DB, got ${URL_ || '(empty)'}`
    )
  }
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
}

beforeAll(async () => {
  assertDevOnly()
  identityDb = createClient(URL_, SERVICE_KEY, {
    db: { schema: 'identity' } as never,
    auth: { persistSession: false, storageKey: `${RUN}-identity` }
  })
  adminAuth = createClient(URL_, SERVICE_KEY, {
    auth: { persistSession: false, storageKey: `${RUN}-admin` }
  })
  cleanupReady = true

  for (const fixture of CASES) {
    const email = `${RUN}-${fixture.key}@fx.local`
    const { data, error } = await adminAuth.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: fixture.metadata
    })
    if (error) throw new Error(`create ${fixture.key}: ${error.message}`)
    created.push({ id: data.user.id, email })
  }
}, 60_000)

afterAll(async () => {
  if (!cleanupReady) return
  const cleanupErrors: Error[] = []
  for (const fixture of [...created].reverse()) {
    const { error } = await adminAuth.auth.admin.deleteUser(fixture.id)
    if (error) cleanupErrors.push(new Error(`delete ${fixture.email}: ${error.message}`))
  }

  if (created.length > 0) {
    const ids = created.map((fixture) => fixture.id)
    const { data, error } = await identityDb.from('users').select('id').in('id', ids)
    if (error) cleanupErrors.push(new Error(`identity residue query: ${error.message}`))
    else if ((data?.length ?? 0) !== 0)
      cleanupErrors.push(new Error(`identity residue: ${data!.length} row(s)`))

    const fixtureEmails = new Set(created.map((fixture) => fixture.email))
    let authResidue = 0
    for (let page = 1; ; page += 1) {
      const { data: pageData, error: pageError } = await adminAuth.auth.admin.listUsers({
        page,
        perPage: 1000
      })
      if (pageError) {
        cleanupErrors.push(new Error(`auth residue query: ${pageError.message}`))
        break
      }
      authResidue += pageData.users.filter(
        (user) => user.email && fixtureEmails.has(user.email)
      ).length
      if (pageData.users.length < 1000) break
    }
    if (authResidue !== 0) cleanupErrors.push(new Error(`auth residue: ${authResidue} user(s)`))
  }

  if (cleanupErrors.length > 0)
    throw new AggregateError(cleanupErrors, 'human avatar fixture cleanup failed')
}, 60_000)

describe('human avatar canonical persistence through live Auth trigger', () => {
  it('stores NULL for missing, classic, and invalid metadata while preserving explicit HTTPS', async () => {
    const ids = created.map((fixture) => fixture.id)
    const { data, error } = await identityDb.from('users').select('id, avatar').in('id', ids)
    if (error) throw new Error(error.message)
    const avatars = new Map(
      (data ?? []).map((row) => [String(row.id), row.avatar as string | null])
    )

    expect(avatars.size).toBe(CASES.length)
    for (const [index, fixture] of CASES.entries()) {
      expect(avatars.get(created[index].id), fixture.key).toBe(fixture.expectedAvatar)
    }
  })

  it('keeps legacy metadata raw but never promotes it into the canonical profile', async () => {
    for (const [index, fixture] of CASES.entries()) {
      const { data, error } = await adminAuth.auth.admin.getUserById(created[index].id)
      if (error) throw new Error(`read ${fixture.key}: ${error.message}`)
      const expectedRawAvatar =
        'avatar_url' in fixture.metadata ? fixture.metadata.avatar_url : undefined
      expect(data.user.user_metadata.avatar_url, fixture.key).toBe(expectedRawAvatar)
      if ('keep' in fixture.metadata)
        expect(data.user.user_metadata.keep).toBe(fixture.metadata.keep)
    }
  })
})
