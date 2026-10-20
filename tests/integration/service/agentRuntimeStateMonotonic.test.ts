import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const SUPABASE_URL = (
  process.env.GUGU_INTEGRATION_SUPABASE_URL
  ?? process.env.GUGU_SUPABASE_URL
  ?? process.env.VITE_SUPABASE_URL
  ?? ''
).trim()
const SERVICE_ROLE_KEY = (
  process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY
  ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? ''
).trim()
const RUN = `runtime-fence-${Date.now().toString(36)}`
const AGENT_ID = randomUUID()
const DEVICE_ID = `${RUN}-device`
const OWNER_EMAIL = `${RUN}@example.test`
const OWNER_PASSWORD = 'RuntimeFence-fixture-pw1'
const NEWER_AT = '2030-01-02T03:04:05.678Z'
const OLDER_AT = '2030-01-02T03:04:04.678Z'

let identityDb: SupabaseClient | null = null
let ownerId = ''

function requireLiveDevDatabase(): void {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(SUPABASE_URL)) {
    throw new Error(`agentRuntimeStateMonotonic.test requires loopback Supabase, got ${SUPABASE_URL || '(missing)'}`)
  }
  if (!SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
}

async function must<T>(request: PromiseLike<unknown>, label: string): Promise<T> {
  const { data, error } = await request as { data: T; error: { message: string } | null }
  if (error) throw new Error(`${label}: ${error.message}`)
  return data
}

beforeAll(async () => {
  requireLiveDevDatabase()
  identityDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    db: { schema: 'identity' } as never,
    auth: { persistSession: false },
  })
  const created = await identityDb.auth.admin.createUser({
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    email_confirm: true,
  })
  if (created.error) throw new Error(`create runtime fence owner: ${created.error.message}`)
  ownerId = created.data.user.id
  await must(identityDb.from('users').upsert({
    id: ownerId,
    display_name: RUN,
    type: 'human',
    avatar: null,
  }), 'insert runtime fence owner')
  await must(identityDb.from('gugu_devices').insert({
    device_id: DEVICE_ID,
    user_id: ownerId,
    machine_id: `${RUN}-machine`,
    label: RUN,
    hostname: 'runtime-fence-host',
    platform: 'linux',
    status: 'online',
  }), 'insert runtime fence device')
  await must(identityDb.from('users').insert({
    id: AGENT_ID,
    display_name: RUN,
    type: 'agent',
    owner_user_id: ownerId,
    device_id: DEVICE_ID,
    desired_status: 'online',
    avatar: null,
  }), 'insert runtime fence agent')
})

afterAll(async () => {
  if (!identityDb) return
  await identityDb.from('users').delete().eq('id', AGENT_ID)
  await identityDb.from('gugu_devices').delete().eq('device_id', DEVICE_ID)
  if (ownerId) {
    await identityDb.from('users').delete().eq('id', ownerId)
    await identityDb.auth.admin.deleteUser(ownerId)
  }
})

describe('agent runtime state monotonic write fence', () => {
  it('rejects an older host write while allowing an equal-version state transition', async () => {
    const db = identityDb!
    await must(db.from('agent_runtime_states').insert({
      agent_user_id: AGENT_ID,
      owner_user_id: ownerId,
      runtime_status: 'online',
      activity_status: 'running',
      active_chat_id: 'chat-b2',
      last_seen_at: NEWER_AT,
    }), 'insert newer B2 state')

    await must(db.from('agent_runtime_states').update({
      runtime_status: 'offline',
      activity_status: 'idle',
      active_chat_id: null,
      last_seen_at: OLDER_AT,
    }).eq('agent_user_id', AGENT_ID), 'attempt older B1 state')

    const afterOlder = await must<{
      runtime_status: string
      activity_status: string
      active_chat_id: string | null
      last_seen_at: string
    }>(db.from('agent_runtime_states')
      .select('runtime_status,activity_status,active_chat_id,last_seen_at')
      .eq('agent_user_id', AGENT_ID)
      .single(), 'read state after older write')
    expect(afterOlder).toMatchObject({
      runtime_status: 'online',
      activity_status: 'running',
      active_chat_id: 'chat-b2',
    })
    expect(new Date(afterOlder.last_seen_at).toISOString()).toBe(NEWER_AT)

    await must(db.from('agent_runtime_states').update({
      activity_status: 'idle',
      active_chat_id: null,
      last_seen_at: NEWER_AT,
    }).eq('agent_user_id', AGENT_ID), 'write equal-version idle state')

    const afterEqual = await must<{
      runtime_status: string
      activity_status: string
      active_chat_id: string | null
      last_seen_at: string
    }>(db.from('agent_runtime_states')
      .select('runtime_status,activity_status,active_chat_id,last_seen_at')
      .eq('agent_user_id', AGENT_ID)
      .single(), 'read state after equal-version write')
    expect(afterEqual).toMatchObject({
      runtime_status: 'online',
      activity_status: 'idle',
      active_chat_id: null,
    })
    expect(new Date(afterEqual.last_seen_at).toISOString()).toBe(NEWER_AT)
  })
})
