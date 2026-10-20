/**
 * #2008 behavior/group-routing.md — 触发矩阵集成验收(确定层 T-cases)。
 *
 * 直接对 live dev 库验证 DB 触发器 chat.enqueue_agent_deliver_device_command 的入队集合:
 * 群配置 人 H(owner) + A(active) + B(passive) + C(active),
 * 逐条插消息、断言 identity.gugu_device_commands 的收件 agent 集合(触发器 AFTER INSERT 同事务,
 * 插入返回即可查,无需轮询)。
 *
 * fixture 全合成:agent/设备/群/成员走 service-role REST;afterAll 逆序清理。
 * 红线:仅回环 dev 库(同 e2e/support/agent-runtime.ts(#6270 已删) 的 devSupabase 约束)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// 连接信息只读环境变量(本地起库后用 `pnpm dev:db env` 导出);本仓 vitest 不注入假 Supabase env。
const envOf = (k: string) => (process.env[k] ?? '').trim()

const URL_ = envOf('VITE_SUPABASE_URL')
const SERVICE_KEY = envOf('SUPABASE_SERVICE_ROLE_KEY')

function assertDevOnly(): void {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URL_)) {
    throw new Error(`groupRoutingTrigger.test 只允许打回环 dev 库,拒绝 ${URL_ || '(空)'}`)
  }
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
}

const RUN = `fxr${Date.now().toString(36)}`
const id = (s: string) => `${RUN}-${s}`

const OWNER_EMAIL = `${RUN}-owner@fx.local`
const OWNER_PASSWORD = 'GuguRouting-fixture-pw1'

let identityDb: SupabaseClient
let chatDb: SupabaseClient
let adminAuth: SupabaseClient
let cleanupReady = false
let ownerUid = ''

const AGENTS = [
  { key: 'a', mode: 'active' },
  { key: 'b', mode: 'passive' },
  { key: 'c', mode: 'active' },
] as const
const agentId = (k: string) => id(`agent-${k}`)
const CHAT = id('chat')
const H2 = id('human2')

async function must<T>(p: PromiseLike<unknown>, label: string): Promise<T> {
  const { data, error } = (await p) as { data: T; error: { message: string } | null }
  if (error) throw new Error(`${label}: ${error.message}`)
  return data
}

/** 触发器与消息插入同事务:插入返回即入队完成,直接查收件集合。 */
async function enqueueSet(messageId: string): Promise<string[]> {
  const rows = await must<Array<{ payload: { agent_user_id?: string; message_id?: string } }>>(
    identityDb.from('gugu_device_commands').select('payload').eq('type', 'agent.deliver')
      .filter('payload->>message_id', 'eq', messageId),
    'query gugu_device_commands'
  )
  return rows.map((r) => String(r.payload.agent_user_id)).sort()
}

async function sendMessage(input: {
  mid: string; sender: string; content: string
  toUserIds?: string[] | null; replyTo?: string | null; isWhisper?: boolean
}): Promise<string[]> {
  await must(
    chatDb.from('messages').insert({
      id: input.mid, chat_id: CHAT, sender_user_id: input.sender,
      content: input.content, content_type: 'text',
      to_user_ids: input.toUserIds ?? null,
      reply_to_message_id: input.replyTo ?? null,
      ...(input.isWhisper ? { is_whisper: true } : {}),
    }).select('id'),
    `insert message ${input.mid}`
  )
  return enqueueSet(input.mid)
}

beforeAll(async () => {
  assertDevOnly()
  identityDb = createClient(URL_, SERVICE_KEY, { db: { schema: 'identity' } as never, auth: { persistSession: false } })
  chatDb = createClient(URL_, SERVICE_KEY, { db: { schema: 'chat' } as never, auth: { persistSession: false } })
  adminAuth = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false } })
  cleanupReady = true

  // owner:真 auth 账号
  const created = await adminAuth.auth.admin.createUser({
    email: OWNER_EMAIL, password: OWNER_PASSWORD, email_confirm: true,
    user_metadata: { nickname: `${RUN}-owner` },
  })
  if (created.error) throw new Error(`createUser: ${created.error.message}`)
  ownerUid = created.data.user.id

  // identity.users 档案可能由触发器自动建;不存在则补(id=auth uid)。
  await identityDb.from('users').upsert(
    { id: ownerUid, display_name: `${RUN}-owner`, type: 'human', avatar: null },
    { onConflict: 'id' })

  // 4 台设备(user_id=owner uuid) + 4 个在线 agent + 第二人类
  for (const a of AGENTS) {
    await must(identityDb.from('gugu_devices').insert({
      device_id: id(`dev-${a.key}`), user_id: ownerUid, machine_id: id(`mach-${a.key}`),
      label: `fx-${a.key}`, hostname: 'fx-host', platform: 'linux', status: 'online',
    }).select('device_id'), `insert device ${a.key}`)
    await must(identityDb.from('users').insert({
      id: agentId(a.key), display_name: `FX-${a.key.toUpperCase()}`, type: 'agent',
      avatar: null,
      owner_user_id: ownerUid, device_id: id(`dev-${a.key}`), desired_status: 'online',
    }).select('id'), `insert agent ${a.key}`)
  }
  await must(identityDb.from('users').insert({
    id: H2, display_name: `${RUN}-h2`, type: 'human', avatar: null,
  }).select('id'), 'insert human2')

  // 群 + 成员(owner 为 owner 角色;agent 档位各异)
  await must(chatDb.from('chats').insert({
    id: CHAT, kind: 'group', status: 'active', creator_user_id: ownerUid, name: `${RUN} routing fixture`,
  }).select('id'), 'insert chat')
  // notification_level 显式钉 'all':真值表不依赖列默认值(member_accepts_delivery 的另一输入轴)。
  const members = [
    { chat_id: CHAT, user_id: ownerUid, role: 'owner', listen_mode: 'active', notification_level: 'all' },
    { chat_id: CHAT, user_id: H2, role: 'member', listen_mode: 'active', notification_level: 'all' },
    ...AGENTS.map((a) => ({ chat_id: CHAT, user_id: agentId(a.key), role: 'member', listen_mode: a.mode, notification_level: 'all' })),
  ]
  await must(chatDb.from('chat_members').insert(members).select('user_id'), 'insert members')

}, 60_000)

afterAll(async () => {
  // beforeAll may fail at the dev-only preflight before the clients exist. Preserve that single
  // fail-loud cause instead of masking it with a secondary undefined-client cleanup error.
  if (!cleanupReady) return

  // 逆序清理;失败单条不阻断后续步骤,但最终必须 fail loud。Supabase 客户端把数据库
  // 失败放在 `{ error }` 而不是 reject Promise,仅靠 try/catch 会把真实残留伪报为成功。
  const cleanupErrors: Error[] = []
  const sweep = async (p: PromiseLike<unknown>, label: string) => {
    try {
      const result = await p as { error?: { message?: string } | null }
      if (result.error) cleanupErrors.push(new Error(`${label}: ${result.error.message ?? 'unknown error'}`))
    } catch (error) {
      cleanupErrors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
  await sweep(identityDb.from('gugu_device_commands').delete().eq('device_id', id('dev-a')), 'delete commands a')
  for (const a of AGENTS) await sweep(identityDb.from('gugu_device_commands').delete().eq('device_id', id(`dev-${a.key}`)), `delete commands ${a.key}`)
  await sweep(chatDb.from('messages').delete().eq('chat_id', CHAT), 'delete messages')
  await sweep(chatDb.from('group_agent_states').delete().eq('chat_id', CHAT), 'delete group agent states')
  // The active-group invariant requires exactly one human owner while the chat exists. Delete the
  // aggregate root first so its FK lifecycle removes members without creating an ownerless live chat.
  await sweep(chatDb.from('chats').delete().eq('id', CHAT), 'delete chat')
  await sweep(chatDb.from('chat_members').delete().eq('chat_id', CHAT), 'verify chat members removed')
  for (const a of AGENTS) await sweep(identityDb.from('users').delete().eq('id', agentId(a.key)), `delete agent ${a.key}`)
  await sweep(identityDb.from('users').delete().eq('id', H2), 'delete secondary human')
  for (const a of AGENTS) await sweep(identityDb.from('gugu_devices').delete().eq('device_id', id(`dev-${a.key}`)), `delete device ${a.key}`)
  if (ownerUid) {
    // Auth deletion is the owner lifecycle entrypoint and removes the linked identity profile in its
    // database transaction. Deleting the profile first makes the Auth trigger fail and strands the user.
    await sweep(adminAuth.auth.admin.deleteUser(ownerUid), 'delete owner auth user')
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'group routing fixture cleanup failed')
}, 60_000)

describe('#2008 group routing trigger matrix (live dev DB)', () => {
  it('T5: agent 发无点名消息 → 无人触发(连环触发防线)', async () => {
    expect(await sendMessage({ mid: id('m-a0'), sender: agentId('a'), content: 'fx open from agent A' }))
      .toEqual([])
  })

  it("T1'(前置): H2 发开放消息 → {A,C}(两个 active,供 T4b 回复)", async () => {
    expect(await sendMessage({ mid: id('m-h2'), sender: H2, content: 'fx open from h2' }))
      .toEqual([agentId('a'), agentId('c')].sort())
  })

  it('T1+T7: H 发无点名消息 → {A,C};passive 的 B 不入队', async () => {
    expect(await sendMessage({ mid: id('m-t1'), sender: ownerUid, content: 'fx open from owner' }))
      .toEqual([agentId('a'), agentId('c')].sort())
  })

  it('T2: H @B(passive) → 只有 {B}(点名穿透档位,其余不触发)', async () => {
    expect(await sendMessage({ mid: id('m-t2'), sender: ownerUid, content: 'fx @B', toUserIds: [agentId('b')] }))
      .toEqual([agentId('b')])
  })

  it('T3: H @all → 全部 agent 含 passive', async () => {
    expect(await sendMessage({ mid: id('m-t3'), sender: ownerUid, content: 'fx @all', toUserIds: ['*'] }))
      .toEqual(AGENTS.map((a) => agentId(a.key)).sort())
  })

  it('T4: H 回复 A 的消息(无 @) → 只有 {A}(回复=定向,active 的 C 也不触发)', async () => {
    expect(await sendMessage({ mid: id('m-t4'), sender: ownerUid, content: 'fx reply to A', replyTo: id('m-a0') }))
      .toEqual([agentId('a')])
  })

  it('T4b: H 回复 H2(人)的消息(无 @) → 无 agent 触发', async () => {
    expect(await sendMessage({ mid: id('m-t4b'), sender: ownerUid, content: 'fx reply to human', replyTo: id('m-h2') }))
      .toEqual([])
  })

  it('T-wr: H 回复 whisper 消息(无 @) → 回落广播 {A,C}(replied_sender 与 preview 同过滤,不短路)', async () => {
    // 先造 whisper:A 密语 owner(人),定向分支目标全为人 → 本身无 agent 触发
    expect(await sendMessage({
      mid: id('m-w'), sender: agentId('a'), content: 'fx whisper', toUserIds: [ownerUid], isWhisper: true,
    })).toEqual([])
    // 回复它:被回复者解析不出(whisper 被过滤) → 视同无点名开放消息
    expect(await sendMessage({ mid: id('m-twr'), sender: ownerUid, content: 'fx reply to whisper', replyTo: id('m-w') }))
      .toEqual([agentId('a'), agentId('c')].sort())
  })

  it('T-dr: H 回复已删除消息(无 @) → 回落广播 {A,C}(不因 reply_to 非空短路成 ∅)', async () => {
    expect(await sendMessage({ mid: id('m-del'), sender: agentId('a'), content: 'fx to be deleted' })).toEqual([])
    await must(
      chatDb.from('messages').update({ deleted_at: new Date().toISOString() }).eq('id', id('m-del')).select('id'),
      'soft-delete m-del'
    )
    expect(await sendMessage({ mid: id('m-tdr'), sender: ownerUid, content: 'fx reply to deleted', replyTo: id('m-del') }))
      .toEqual([agentId('a'), agentId('c')].sort())
  })

  it('T6: A(agent) 发 "@C" → {C}(agent 消息里的显式 @ 照常触发=交接口子)', async () => {
    expect(await sendMessage({ mid: id('m-t6'), sender: agentId('a'), content: 'fx handoff @C', toUserIds: [agentId('c')] }))
      .toEqual([agentId('c')])
  })

  it('T-union: @B 同时回复 A 的消息 → 并集 {A,B}', async () => {
    expect(await sendMessage({
      mid: id('m-tu'), sender: ownerUid, content: 'fx union', toUserIds: [agentId('b')], replyTo: id('m-a0'),
    })).toEqual([agentId('a'), agentId('b')].sort())
  })

  it('T-union2: @A 同时回复 H2(人)的消息 → 仅 {A}(人不是 agent 收件人)', async () => {
    expect(await sendMessage({
      mid: id('m-tu2'), sender: ownerUid, content: 'fx union h2', toUserIds: [agentId('a')], replyTo: id('m-h2'),
    })).toEqual([agentId('a')])
  })
})
