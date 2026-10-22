/**
 * chat.decide_group_join 经 PostgREST 调用(迁移 20261022152000_approved_task_seat_wakes_agent 换了它里面调的
 * chat.insert_group_member 的签名)。
 *
 * 已发布的客户端是经 PostgREST 按参数名调用它的 —— 在 SQL 里调通不代表那条路通(10-22 夜里一次签名改动后,老客户端
 * 「添加失败」正是只在 REST 那一层坏的)。这里用和客户端 groupAdmin.decideJoin 一样的调用:群主的真 session、
 * chat schema、三个具名参数:
 *   · 任务座位(排队时要 passive)被批准:照旧调得通,被动入座,入群那一行点名它;
 *   · 对照:普通 agent(排队时要 active)被批准:主动入座,入群那一行不点名 —— 证明两次落在同一个函数上,判据也确实生效。
 *
 * 红线:仅回环本机库。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const envOf = (k: string) => (process.env[k] ?? '').trim()
const URL_ = envOf('VITE_SUPABASE_URL')
const SERVICE_KEY = envOf('SUPABASE_SERVICE_ROLE_KEY')
const ANON_KEY = envOf('VITE_SUPABASE_ANON_KEY')

const RUN = `dgj${Date.now().toString(36)}`
const id = (s: string) => `${RUN}-${s}`
const OWNER_EMAIL = `${RUN}-owner@fx.local`
const OWNER_PASSWORD = 'GuguDecideJoinRest-fixture-pw1' // gitleaks:allow -- fixture password for disposable loopback Auth users
const DEV = id('dev')
const AGENT_TASK = id('agent-task-seat')
const AGENT_PLAIN = id('agent-plain')
const CHAT = crypto.randomUUID()

let identityDb: SupabaseClient
let chatDb: SupabaseClient
let adminAuth: SupabaseClient
let ownerChat: SupabaseClient
let ownerUid = ''
let cleanupReady = false

async function must<T>(p: PromiseLike<unknown>, label: string): Promise<T> {
  const { data, error } = (await p) as { data: T; error: { message: string } | null }
  if (error) throw new Error(`${label}: ${error.message}`)
  return data
}
async function seat(agent: string): Promise<string | undefined> {
  const rows = await must<Array<{ listen_mode: string }>>(
    chatDb.from('chat_members').select('listen_mode').eq('chat_id', CHAT).eq('user_id', agent), `seat ${agent}`)
  return rows[0]?.listen_mode
}
async function joinRowTo(agent: string): Promise<string[] | null | undefined> {
  const rows = await must<Array<{ to_user_ids: string[] | null }>>(
    chatDb.from('messages').select('to_user_ids').eq('chat_id', CHAT).like('client_message_id', `member-joined:%:${agent}`),
    `join row ${agent}`)
  expect(rows).toHaveLength(1)
  return rows[0]?.to_user_ids
}
/** 排队落请求的那一口(queue_agent_join_request)只开给 service_role;客户端经 provision / add_group_agent 落到它。 */
async function queue(agent: string, listenMode: 'active' | 'passive'): Promise<string> {
  return must<string>(chatDb.rpc('queue_agent_join_request', {
    p_chat_id: CHAT, p_agent_user_id: agent, p_requested_by: ownerUid, p_message: null, p_listen_mode: listenMode,
  }), `queue ${agent}`)
}

beforeAll(async () => {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URL_)) throw new Error(`decideGroupJoinRest.test 只允许打回环本机库,拒绝 ${URL_ || '(空)'}`)
  if (!SERVICE_KEY || !ANON_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY and VITE_SUPABASE_ANON_KEY are required')
  identityDb = createClient(URL_, SERVICE_KEY, { db: { schema: 'identity' } as never, auth: { persistSession: false } })
  chatDb = createClient(URL_, SERVICE_KEY, { db: { schema: 'chat' } as never, auth: { persistSession: false } })
  adminAuth = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false } })
  cleanupReady = true

  const created = await adminAuth.auth.admin.createUser({ email: OWNER_EMAIL, password: OWNER_PASSWORD, email_confirm: true })
  if (created.error) throw new Error(`createUser: ${created.error.message}`)
  ownerUid = created.data.user.id
  await must(identityDb.from('users').upsert({ id: ownerUid, display_name: `${RUN}-owner`, type: 'human', avatar: null }, { onConflict: 'id' }), 'upsert owner')
  await must(identityDb.from('gugu_devices').insert({
    device_id: DEV, user_id: ownerUid, machine_id: id('mach'), label: 'dgj', hostname: 'dgj-host', platform: 'linux', status: 'online',
  }).select('device_id'), 'insert device')
  for (const agent of [AGENT_TASK, AGENT_PLAIN]) {
    await must(identityDb.from('users').insert({
      id: agent, display_name: agent, type: 'agent', avatar: null, owner_user_id: ownerUid, device_id: DEV, desired_status: 'online',
    }).select('id'), `insert ${agent}`)
  }

  ownerChat = createClient(URL_, ANON_KEY, { db: { schema: 'chat' } as never, auth: { persistSession: false } })
  const signedIn = await ownerChat.auth.signInWithPassword({ email: OWNER_EMAIL, password: OWNER_PASSWORD })
  if (signedIn.error) throw new Error(`owner signIn: ${signedIn.error.message}`)
  await must(ownerChat.rpc('create_gugu_group', {
    p_chat_id: CHAT, p_name: `${RUN} decide-join`, p_owner_user_id: ownerUid, p_initial_members: [],
  }), 'create_gugu_group')
}, 60_000)

afterAll(async () => {
  if (!cleanupReady) return
  const errors: string[] = []
  const sweep = async (p: PromiseLike<unknown>, label: string) => {
    try {
      const result = await p as { error?: { message?: string } | null }
      if (result.error) errors.push(`${label}: ${result.error.message ?? 'unknown error'}`)
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await sweep(chatDb.from('messages').delete().eq('chat_id', CHAT), 'delete messages')
  await sweep(chatDb.from('chats').delete().eq('id', CHAT), 'delete chat')
  await sweep(identityDb.from('gugu_device_commands').delete().eq('device_id', DEV), 'delete device commands')
  for (const agent of [AGENT_TASK, AGENT_PLAIN]) await sweep(identityDb.from('users').delete().eq('id', agent), `delete ${agent}`)
  await sweep(identityDb.from('gugu_devices').delete().eq('device_id', DEV), 'delete device')
  if (ownerUid) await sweep(adminAuth.auth.admin.deleteUser(ownerUid), 'delete owner auth user')
  if (errors.length) throw new Error(`fixture cleanup failed:\n${errors.join('\n')}`)
}, 60_000)

describe('chat.decide_group_join 经 PostgREST', () => {
  it('老客户端的三个具名参数照旧调得通:任务座位被动入座,入群那一行点名它', async () => {
    const request = await queue(AGENT_TASK, 'passive')
    const result = await must<{ status: string }>(ownerChat.rpc('decide_group_join', {
      p_request_id: request, p_accept: true, p_as_user_id: ownerUid,
    }), 'decide_group_join (three named args)')
    expect(result).toMatchObject({ status: 'accepted', chat_id: CHAT })
    expect(await seat(AGENT_TASK)).toBe('passive')
    expect(await joinRowTo(AGENT_TASK)).toEqual([AGENT_TASK])
  })

  it('对照:普通 agent 被批准 ⇒ 主动入座,入群那一行不点名', async () => {
    const request = await queue(AGENT_PLAIN, 'active')
    const result = await must<{ status: string }>(ownerChat.rpc('decide_group_join', {
      p_request_id: request, p_accept: true, p_as_user_id: ownerUid,
    }), 'decide_group_join (plain agent)')
    expect(result).toMatchObject({ status: 'accepted', chat_id: CHAT })
    expect(await seat(AGENT_PLAIN)).toBe('active')
    expect(await joinRowTo(AGENT_PLAIN)).toBeNull()
  })
})
