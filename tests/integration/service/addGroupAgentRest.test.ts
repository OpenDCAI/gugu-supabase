/**
 * chat.add_group_agent 经 PostgREST 调用(迁移 20261022150000_task_seat_from_chat 加了 p_as_task、去掉了旧的四参签名)。
 *
 * 签名一变,已发布的客户端是经 PostgREST 按参数名调用的 —— 在 SQL 里直接调通不代表那条路通(10-22 夜里一次签名改动后,
 * 老客户端「添加失败」正是只在 REST 那一层坏的)。这里用和客户端 groupAdmin.addAgent 一样的调用:owner 的真 session、
 * chat schema、四个具名参数,不传 p_as_task:
 *   · 老调用照旧调得通,agent 主动入座、照常出「加入了群聊」;
 *   · 对照:同一条路径带上 p_as_task = true,不提示 —— 证明两次调用确实落在同一个函数上,参数也确实生效。
 *
 * 红线:仅回环本机库。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const envOf = (k: string) => (process.env[k] ?? '').trim()
const URL_ = envOf('VITE_SUPABASE_URL')
const SERVICE_KEY = envOf('SUPABASE_SERVICE_ROLE_KEY')
const ANON_KEY = envOf('VITE_SUPABASE_ANON_KEY')

const RUN = `aga${Date.now().toString(36)}`
const id = (s: string) => `${RUN}-${s}`
const OWNER_EMAIL = `${RUN}-owner@fx.local`
const OWNER_PASSWORD = 'GuguAddAgentRest-fixture-pw1' // gitleaks:allow -- fixture password for disposable loopback Auth users
const DEV = id('dev')
const AGENT_OLD = id('agent-old-call')
const AGENT_TASK = id('agent-task-call')
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
async function joinNoticeFor(agent: string): Promise<number> {
  const rows = await must<Array<{ client_message_id: string }>>(
    chatDb.from('messages').select('client_message_id').eq('chat_id', CHAT).like('client_message_id', `member-joined:%:${agent}`),
    `join notice ${agent}`)
  return rows.length
}

beforeAll(async () => {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URL_)) throw new Error(`addGroupAgentRest.test 只允许打回环本机库,拒绝 ${URL_ || '(空)'}`)
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
    device_id: DEV, user_id: ownerUid, machine_id: id('mach'), label: 'aga', hostname: 'aga-host', platform: 'linux', status: 'online',
  }).select('device_id'), 'insert device')
  for (const agent of [AGENT_OLD, AGENT_TASK]) {
    await must(identityDb.from('users').insert({
      id: agent, display_name: agent, type: 'agent', avatar: null, owner_user_id: ownerUid, device_id: DEV, desired_status: 'online',
    }).select('id'), `insert ${agent}`)
  }

  ownerChat = createClient(URL_, ANON_KEY, { db: { schema: 'chat' } as never, auth: { persistSession: false } })
  const signedIn = await ownerChat.auth.signInWithPassword({ email: OWNER_EMAIL, password: OWNER_PASSWORD })
  if (signedIn.error) throw new Error(`owner signIn: ${signedIn.error.message}`)
  // 只有群主一个人的群,和客户端建群走同一个 RPC。
  await must(ownerChat.rpc('create_gugu_group', {
    p_chat_id: CHAT, p_name: `${RUN} add-agent`, p_owner_user_id: ownerUid, p_initial_members: [],
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
  for (const agent of [AGENT_OLD, AGENT_TASK]) await sweep(identityDb.from('users').delete().eq('id', agent), `delete ${agent}`)
  await sweep(identityDb.from('gugu_devices').delete().eq('device_id', DEV), 'delete device')
  if (ownerUid) await sweep(adminAuth.auth.admin.deleteUser(ownerUid), 'delete owner auth user')
  if (errors.length) throw new Error(`fixture cleanup failed:\n${errors.join('\n')}`)
}, 60_000)

describe('chat.add_group_agent 经 PostgREST', () => {
  it('老客户端的四个具名参数(不传 p_as_task)照旧调得通:主动入座,照常出「加入了群聊」', async () => {
    const result = await must<{ status: string }>(ownerChat.rpc('add_group_agent', {
      p_chat_id: CHAT, p_agent_user_id: AGENT_OLD, p_message: null, p_as_user_id: ownerUid,
    }), 'add_group_agent (four named args)')
    expect(result).toMatchObject({ status: 'joined', chat_id: CHAT })
    expect(await seat(AGENT_OLD)).toBe('active')
    expect(await joinNoticeFor(AGENT_OLD)).toBe(1)
  })

  it('对照:同一条路径带上 p_as_task = true ⇒ 主动入座,不提示', async () => {
    const result = await must<{ status: string }>(ownerChat.rpc('add_group_agent', {
      p_chat_id: CHAT, p_agent_user_id: AGENT_TASK, p_message: null, p_as_user_id: ownerUid, p_as_task: true,
    }), 'add_group_agent (task seat)')
    expect(result).toMatchObject({ status: 'joined', chat_id: CHAT })
    expect(await seat(AGENT_TASK)).toBe('active')
    expect(await joinNoticeFor(AGENT_TASK)).toBe(0)
  })
})
