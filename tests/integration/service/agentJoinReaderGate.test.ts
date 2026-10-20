/**
 * #5258 delivery-routing「入群门」—— 对**真库**验收触发器与 RPC 本体。
 *
 * 单测那一格(agentInboxReader.test.ts)跑在 FakeCloud 上,它逐字段镜像这道门;镜像永远不会告诉你
 * `chat.set_join_instant_on_membership_insert` 和 `identity.pull_agent_inbox_v2` 在真库里到底干了什么。
 * 本用例让这两个对象**各真跑一次**:成员行经 service-role REST 插入(与产品同一条 INSERT)触发器就位,
 * RPC 则以 **owner 的真 session** 调用(它 fail-closed 于 auth.uid(),service-role 调不动)。
 *
 * 判据的阳控是**同一个 RPC 的另一个 agent**:F 在消息之前入群、L 在消息之后入群,同一条调用路径、
 * 同一批消息,只有入群时刻不同 —— F 拿得到那几条就证明「L 拿不到」是门挡的,不是别的过滤器顺手挡的
 * (铁律 3:探针先证明能产出与期待相反的结果)。
 *
 * 红线:仅回环本机库(同 groupRoutingTrigger.test.ts 的 devSupabase 约束)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const envOf = (k: string) => (process.env[k] ?? '').trim()

const URL_ = envOf('VITE_SUPABASE_URL')
const SERVICE_KEY = envOf('SUPABASE_SERVICE_ROLE_KEY')
const ANON_KEY = envOf('VITE_SUPABASE_ANON_KEY')

function assertLoopbackOnly(): void {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URL_)) {
    throw new Error(`agentJoinReaderGate.test 只允许打回环本机库,拒绝 ${URL_ || '(空)'}`)
  }
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  if (!ANON_KEY) throw new Error('VITE_SUPABASE_ANON_KEY is required (RPC 要以 owner 真身份调用)')
}

const RUN = `jgr${Date.now().toString(36)}`
const id = (s: string) => `${RUN}-${s}`

const OWNER_EMAIL = `${RUN}-owner@fx.local`
const OWNER_PASSWORD = 'GuguJoinGate-fixture-pw1' // gitleaks:allow -- fixture password for disposable loopback Auth users

/** F = founding,消息之前入群;L = late,消息之后入群。 */
const AGENT_F = id('agent-f')
const AGENT_L = id('agent-l')
const CHAT = id('chat')
const H2 = id('human2')
const DEV = id('dev')

/** 入群前的三条 + 入群后的一条。 */
const PRE = [id('msg-pre-1'), id('msg-pre-2'), id('msg-pre-3')]
const POST = id('msg-post')

let identityDb: SupabaseClient
let chatDb: SupabaseClient
let adminAuth: SupabaseClient
let ownerRpc: SupabaseClient
let cleanupReady = false
let ownerUid = ''
let lateJoinedAt = ''
let historyBoundary = 0

async function must<T>(p: PromiseLike<unknown>, label: string): Promise<T> {
  const { data, error } = (await p) as { data: T; error: { message: string } | null }
  if (error) throw new Error(`${label}: ${error.message}`)
  return data
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function postMessage(mid: string): Promise<void> {
  await must(chatDb.from('messages').insert({
    id: mid, chat_id: CHAT, sender_user_id: ownerUid, content: `${mid} body`, content_type: 'text',
  }).select('id'), `insert ${mid}`)
}

/** 以 owner 的真 session 调读者的唯一读口,返回它交出来的 message id(按 seq)。 */
async function pulledIds(agentUserId: string): Promise<string[]> {
  const rows = await must<Array<{ id: string; seq: number }>>(
    ownerRpc.rpc('pull_agent_inbox_v2', { p_agent_user_id: agentUserId, p_chat_id: CHAT }),
    `pull_agent_inbox_v2 ${agentUserId}`,
  )
  return rows.sort((a, b) => a.seq - b.seq).map((r) => r.id)
}

async function joinContext(agentUserId: string): Promise<Array<{
  joined_at: string
  skipped_before_join: number
  before_seq: number
  first_pull: boolean
}>> {
  return must<Array<{
    joined_at: string
    skipped_before_join: number
    before_seq: number
    first_pull: boolean
  }>>(ownerRpc.rpc('get_agent_join_context', {
    p_agent_user_id: agentUserId,
    p_chat_id: CHAT,
  }), `get_agent_join_context ${agentUserId}`)
}

beforeAll(async () => {
  assertLoopbackOnly()
  identityDb = createClient(URL_, SERVICE_KEY, { db: { schema: 'identity' } as never, auth: { persistSession: false } })
  chatDb = createClient(URL_, SERVICE_KEY, { db: { schema: 'chat' } as never, auth: { persistSession: false } })
  adminAuth = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false } })
  cleanupReady = true

  const created = await adminAuth.auth.admin.createUser({
    email: OWNER_EMAIL, password: OWNER_PASSWORD, email_confirm: true,
    user_metadata: { nickname: `${RUN}-owner` },
  })
  if (created.error) throw new Error(`createUser: ${created.error.message}`)
  ownerUid = created.data.user.id

  await must(identityDb.from('users').upsert(
    { id: ownerUid, display_name: `${RUN}-owner`, type: 'human', avatar: null }, { onConflict: 'id' }), 'upsert owner')

  await must(identityDb.from('gugu_devices').insert({
    device_id: DEV, user_id: ownerUid, machine_id: id('mach'), label: 'jg', hostname: 'jg-host',
    platform: 'linux', status: 'online',
  }).select('device_id'), 'insert device')
  for (const [agent, name] of [[AGENT_F, 'JG-F'], [AGENT_L, 'JG-L']] as const) {
    await must(identityDb.from('users').insert({
      id: agent, display_name: name, type: 'agent', avatar: null,
      owner_user_id: ownerUid, device_id: DEV, desired_status: 'online',
    }).select('id'), `insert ${name}`)
  }
  await must(identityDb.from('users').insert({
    id: H2, display_name: `${RUN}-h2`, type: 'human', avatar: null,
  }).select('id'), 'insert human2')

  await must(chatDb.from('chats').insert({
    id: CHAT, kind: 'group', status: 'active', creator_user_id: ownerUid, name: `${RUN} join-gate fixture`,
  }).select('id'), 'insert chat')

  // 首批成员必须一次到 ≥3:active 群的成员数不变量是 DEFERRABLE CONSTRAINT TRIGGER,按事务结算。
  // F 在这一刻入群 —— 也就是**消息之前**。
  await must(chatDb.from('chat_members').insert([
    { chat_id: CHAT, user_id: ownerUid, role: 'owner', listen_mode: 'active', notification_level: 'all' },
    { chat_id: CHAT, user_id: H2, role: 'member', listen_mode: 'active', notification_level: 'all' },
    { chat_id: CHAT, user_id: AGENT_F, role: 'member', listen_mode: 'active', notification_level: 'all' },
  ]).select('user_id'), 'insert founding members')

  for (const mid of PRE) await postMessage(mid)
  // System notices also consume sequence values. Bind the exclusive history boundary
  // to the fixture's last real pre-join message, rather than assuming seq starts at 1.
  const preRows = await must<Array<{ seq: number }>>(
    chatDb.from('messages').select('seq').eq('id', PRE[PRE.length - 1]), 'read pre-join head')
  historyBoundary = preRows[0].seq + 1
  await wait(1100) // 让「入群前」在真时钟上是一个可读的间隔,不靠微秒级先后

  // L 入群,并**故意**塞一个 1970 年的 joined_at:客户端持表级 INSERT,这一格就是它能绕门的地方。
  await must(chatDb.from('chat_members').insert({
    chat_id: CHAT, user_id: AGENT_L, role: 'member', listen_mode: 'active', notification_level: 'all',
    joined_at: '1970-01-01T00:00:00.000Z',
  }).select('user_id'), 'insert late member')

  await wait(200)
  await postMessage(POST)

  const rows = await must<Array<{ joined_at: string; last_read_seq: number }>>(
    chatDb.from('chat_members').select('joined_at, last_read_seq').eq('chat_id', CHAT).eq('user_id', AGENT_L),
    'read late membership')
  lateJoinedAt = rows[0]!.joined_at

  ownerRpc = createClient(URL_, ANON_KEY, { db: { schema: 'identity' } as never, auth: { persistSession: false } })
  const signedIn = await ownerRpc.auth.signInWithPassword({ email: OWNER_EMAIL, password: OWNER_PASSWORD })
  if (signedIn.error) throw new Error(`owner signIn: ${signedIn.error.message}`)
}, 60_000)

afterAll(async () => {
  if (!cleanupReady) return
  const cleanupErrors: Error[] = []
  const sweep = async (p: PromiseLike<unknown>, label: string) => {
    try {
      const result = await p as { error?: { message?: string } | null }
      if (result.error) cleanupErrors.push(new Error(`${label}: ${result.error.message ?? 'unknown error'}`))
    } catch (error) {
      cleanupErrors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
  await sweep(chatDb.from('messages').delete().eq('chat_id', CHAT), 'delete messages')
  await sweep(chatDb.from('chats').delete().eq('id', CHAT), 'delete chat')
  await sweep(chatDb.from('chat_members').delete().eq('chat_id', CHAT), 'verify chat members removed')
  for (const agent of [AGENT_F, AGENT_L]) await sweep(identityDb.from('users').delete().eq('id', agent), `delete ${agent}`)
  await sweep(identityDb.from('users').delete().eq('id', H2), 'delete secondary human')
  await sweep(identityDb.from('gugu_devices').delete().eq('device_id', DEV), 'delete device')
  if (ownerUid) await sweep(adminAuth.auth.admin.deleteUser(ownerUid), 'delete owner auth user')
  if (cleanupErrors.length) throw new Error(`fixture cleanup failed:\n${cleanupErrors.map((e) => e.message).join('\n')}`)
}, 60_000)

describe('#5258 入群门在真库上的行为(触发器 + pull_agent_inbox_v2 本体)', () => {
  it('触发器无条件覆盖客户端传来的 joined_at —— 1970 那个值进不去', () => {
    // 客户端持 `GRANT INSERT ON chat.chat_members`(026),不覆盖就能靠一个过去的时间戳读走全部历史。
    expect(new Date(lateJoinedAt).getUTCFullYear()).toBeGreaterThan(2020)
    expect(new Date(lateJoinedAt).getTime()).toBeGreaterThan(Date.now() - 10 * 60_000)
  })

  it('入群不推高 last_read_seq —— 已读要靠真投递挣来,不由入群本身伪造', async () => {
    // 这一列同时是人的聊天页判「agent 已读」的依据(deriveReadReceipt 以 水位 ≥ seq 判已读),
    // 预置到 head 会让入群前那几条在人眼里当场变成 agent 已读。
    const rows = await must<Array<{ last_read_seq: number }>>(
      chatDb.from('chat_members').select('last_read_seq').eq('chat_id', CHAT).eq('user_id', AGENT_L),
      'read late watermark')
    expect(rows[0]!.last_read_seq).toBe(0)
  })

  it('RPC 只把入群后的消息交给晚入群的 agent', async () => {
    expect(await pulledIds(AGENT_L)).toEqual([POST])
  })

  it('message_rules 的事实 RPC 只在首次读且 N>0 时给出历史边界', async () => {
    const rows = await joinContext(AGENT_L)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      joined_at: lateJoinedAt,
      skipped_before_join: 3,
      before_seq: historyBoundary,
      first_pull: true,
    })
    expect(await joinContext(AGENT_L)).toEqual([])
    // F 在三条消息前已入群，是 N=0 的阴控；它不能被常驻规则文案误判成需要回看。
    expect(await joinContext(AGENT_F)).toEqual([])
  })

  it('阳控(同一 RPC、同一批消息、只有入群时刻不同):消息之前入群的 agent 四条全拿得到', async () => {
    // 没有这一格,「L 只拿到一条」也可能是别的过滤器造成的,而不是入群门。
    expect(await pulledIds(AGENT_F)).toEqual([...PRE, POST])
  })
})
