import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, '../../../deploy/kong', name), 'utf8'))

// The admin upstreams the Supabase CLI routes through Kong with CORS only.
const ADMIN = ['pg-meta', 'mcp', 'rest-admin-v1', 'analytics-v1', 'pooler-v2-ws']
// Tenant services: the app reaches these with the anon/publishable key or a user session.
const TENANT = ['auth-v1-open', 'auth-v1-open-callback', 'auth-v1-open-authorize', 'auth-v1', 'rest-v1', 'graphql-v1',
  'realtime-v1-ws', 'realtime-v1-rest', 'storage-v1-s3', 'storage-v1', 'functions-v1', 'well-known-oauth']

describe('self-managed gateway policies', () => {
  it('requires the service-role key on every CLI admin route and on nothing else', () => {
    const policy = read('admin-routes.json')
    expect(Object.keys(policy)).toEqual(['service_role_only'])
    expect([...policy.service_role_only].sort()).toEqual([...ADMIN].sort())
    expect(new Set(policy.service_role_only).size).toBe(policy.service_role_only.length)
    for (const service of TENANT) expect(policy.service_role_only).not.toContain(service)
  })

  it('keeps the CORS policy on tenant services only', () => {
    const policy = read('storage-cors.json')
    for (const service of Object.keys(policy)) {
      expect(TENANT).toContain(service)
      expect(ADMIN).not.toContain(service)
    }
  })
})
