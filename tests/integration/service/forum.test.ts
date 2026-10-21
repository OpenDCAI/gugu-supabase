// 社区论坛与积分悬赏(release 20261021100000_forum,源自旧后端 20261020153000_forum):帖子、回复、表情只经 public.forum_* RPC 读写,可见性只有一个谓词;
// 悬赏用社区积分(只追加流水 + identity.users.community_points 余额),billing 不碰;agent 经 agent.deliver(source=forum)
// 叫醒、按 acked_seq 拉帖内事件。每条否定断言配一个正对照;最后按流水逐人对账。
// loopback PostgreSQL、`GUGU_INTEGRATION_DATABASE_URL`,每条用例 BEGIN…ROLLBACK。
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface QueryResult<Row> { rows: Row[] }
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>
}

const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
const DATABASE_URL = (process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '').trim()
let database: DatabaseClient

beforeAll(async () => {
  const parsed = new URL(DATABASE_URL)
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`forum.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})
afterAll(async () => { await database?.end() })

async function inRollback(body: () => Promise<void>): Promise<void> {
  await database.query('BEGIN')
  try {
    await body()
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await database.query('ROLLBACK')
  }
}

async function as<Row>(asUser: string, sql: string, values: unknown[] = []): Promise<{ rows: Row[]; error: string | null }> {
  await database.query('SAVEPOINT attempt')
  try {
    await database.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('role', 'authenticated', true)`, [
      JSON.stringify({ sub: asUser, role: 'authenticated' }), asUser,
    ])
    const result = await database.query<Row>(sql, values)
    await database.query(`SELECT set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)`)
    await database.query('RELEASE SAVEPOINT attempt')
    return { rows: result.rows, error: null }
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT attempt')
    await database.query(`SELECT set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)`)
    return { rows: [], error: String((error as Error).message) }
  }
}

async function ok<Row>(asUser: string, sql: string, values: unknown[] = []): Promise<Row[]> {
  const result = await as<Row>(asUser, sql, values)
  if (result.error) throw new Error(`${sql}: ${result.error}`)
  return result.rows
}

/** A person old enough (so they may post and reply), holding `points` community points (granted by 中台). */
async function person(name: string, opts: { points?: number, ageDays?: number } = {}): Promise<string> {
  const id = randomUUID()
  await database.query(
    `INSERT INTO auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     VALUES ($1, 'authenticated', 'authenticated', $2, now(), '{"provider":"email","providers":["email"]}', '{}', now(), now())`,
    [id, `it-forum-${id}@example.com`],
  )
  await database.query(`UPDATE identity.users SET display_name = $2, created_at = now() - make_interval(days => $3) WHERE id = $1`,
    [id, name, opts.ageDays ?? 30])
  for (let left = opts.points ?? 0; left > 0; left -= 100) {
    await database.query(`SELECT public.forum_points_grant('it-中台', $1, $2, '测试发分', 'test')`, [id, Math.min(100, left)])
  }
  return id
}

/** An online agent on a device of its owner (so the forum trigger can enqueue agent.deliver for it). */
async function agentOf(owner: string, name: string): Promise<string> {
  const device = `dev-${randomUUID()}`
  await database.query(`INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ($1,$2,'it','it','darwin')`, [device, owner])
  const id = randomUUID()
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id, desired_status) VALUES ($1,'agent',$2,$3,$4,'online')`,
    [id, name, owner, device])
  return id
}

const balance = async (user: string) => Number((await database.query<{ b: string }>(
  `SELECT community_points::text AS b FROM identity.users WHERE id = $1`, [user])).rows[0]!.b)

async function post(poster: string, amount?: number, visibility: 'public' | 'poster_only' = 'public', days = 3): Promise<string> {
  const rows = amount === undefined
    ? await ok<{ id: string }>(poster, `SELECT public.forum_create_post('帮我看看这个问题', '问题正文') AS id`)
    : await ok<{ id: string }>(poster, `SELECT public.forum_create_post('帮我看看这个问题', '问题正文', $1, $2, $3) AS id`, [amount, days, visibility])
  return rows[0]!.id
}

const reply = (who: string, postId: string, text: string, opts: { as?: string, replyTo?: string } = {}) =>
  as<{ id: string }>(who, `SELECT public.forum_reply($1, $2, $3, $4) AS id`, [postId, text, opts.replyTo ?? null, opts.as ?? null])

async function replied(who: string, postId: string, text: string, opts: { as?: string, replyTo?: string } = {}): Promise<string> {
  const result = await reply(who, postId, text, opts)
  if (result.error) throw new Error(result.error)
  return result.rows[0]!.id
}

interface Read {
  seq: number
  replies: Array<{ id: string, body: string, to_poster_only: boolean, author_user_id: string }>
  reactions: Array<{ target_kind: string, target_id: string, emoji: string, count: number, mine: boolean }>
  assignments: Array<{ agent_user_id: string, delivery_state: string, last_error: string | null }>
  bounty: { status: string, refunded: number, burned: number } | null
}
const read = async (who: string, postId: string, asId?: string): Promise<Read> =>
  (await ok<{ r: Read }>(who, `SELECT public.forum_read_post($1, $2) AS r`, [postId, asId ?? null]))[0]!.r

const forumCommands = async (agent: string) => (await database.query<{ payload: { post_id: string, event_seq: number, source: string } }>(
  `SELECT payload FROM identity.gugu_device_commands
    WHERE type = 'agent.deliver' AND payload->>'agent_user_id' = $1 ORDER BY created_at, (payload->>'event_seq')::int`, [agent])).rows.map((r) => r.payload)

interface InboxRow { post_id: string, seq: string, kind: string, entity_id: string, reply_body: string | null }
const pull = (owner: string, agent: string) => ok<InboxRow>(owner, `SELECT * FROM public.forum_pull_agent_inbox($1)`, [agent])

const award = (poster: string, postId: string, awards: Array<{ reply_id: string, amount: number }>) =>
  as<{ status: string }>(poster, `SELECT (public.forum_award($1, $2::jsonb)).status AS status`, [postId, JSON.stringify(awards)])

/** Pretend the post went up two days ago (awarding opens 24 h after posting). */
const age = (postId: string) => database.query(`UPDATE public.forum_bounties SET created_at = now() - interval '2 days' WHERE post_id = $1`, [postId])

describe('posts and replies', () => {
  it('a reader who never took part reads the post and its public replies', async () => {
    await inRollback(async () => {
      const alice = await person('Alice')
      const bob = await person('Bob')
      const reader = await person('Reader')
      const id = await post(alice)
      await replied(bob, id, '我的回答')
      const seen = await read(reader, id)
      expect(seen.replies.map((r) => r.body)).toEqual(['我的回答'])
      expect((await database.query(`SELECT 1 FROM public.forum_participants WHERE post_id = $1 AND user_id = $2`, [id, reader])).rows).toEqual([])
      const listed = await ok<{ post_id: string, reply_count: number }>(reader, `SELECT post_id, reply_count FROM public.forum_list_posts()`)
      expect(listed.find((row) => row.post_id === id)?.reply_count).toBe(1)
      expect(await ok(reader, `SELECT user_id, community_points::int AS points FROM public.forum_me()`)).toEqual([{ user_id: reader, points: 0 }])
    })
  })

  it('the tables themselves are closed to clients: everything goes through the RPCs', async () => {
    await inRollback(async () => {
      const alice = await person('Alice')
      await post(alice)
      for (const table of ['forum_posts', 'forum_replies', 'forum_reactions', 'forum_bounties', 'forum_post_events', 'forum_assignments']) {
        expect((await as(alice, `SELECT * FROM public.${table}`)).error).toMatch(/permission denied/)
      }
      // 控:流水表本人可读。
      expect((await as(alice, `SELECT * FROM public.forum_community_points`)).error).toBeNull()
    })
  })

  it('new accounts cannot post or reply; old ones can; a deployment may tighten the gate', async () => {
    await inRollback(async () => {
      const alice = await person('Alice')
      const fresh = await person('Fresh', { ageDays: 1 })
      const unclaimed = await person('Unclaimed')
      // 部署方只覆盖 public.forum_account_established 这一个函数(官方版在私仓叠加层里加设备认领条件)。
      await database.query(`CREATE OR REPLACE FUNCTION public.forum_account_established(p_user_id TEXT) RETURNS BOOLEAN
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $f$
          SELECT EXISTS (SELECT 1 FROM identity.users u WHERE u.id = p_user_id
            AND u.created_at <= pg_catalog.now() - INTERVAL '3 days' AND u.display_name <> 'Unclaimed')
        $f$`)
      expect((await as(fresh, `SELECT public.forum_create_post('t', 'b')`)).error).toMatch(/account_too_new/)
      const id = await post(alice)
      expect((await reply(fresh, id, 'hi')).error).toMatch(/account_too_new/)
      expect((await reply(unclaimed, id, 'hi')).error).toMatch(/account_too_new/)
      expect((await reply(await person('Old'), id, 'hi')).error).toBeNull()
    })
  })

  it('rate limit: 10 replies per identity per post in 10 minutes; the poster is not limited', async () => {
    await inRollback(async () => {
      const alice = await person('Alice')
      const bob = await person('Bob')
      const id = await post(alice)
      for (let i = 0; i < 10; i += 1) await replied(bob, id, `第 ${i} 条`)
      expect((await reply(bob, id, '第 11 条')).error).toMatch(/rate-limited/)
      for (let i = 0; i < 12; i += 1) await replied(alice, id, `楼主第 ${i} 条`)
    })
  })

  it('a blocked person and their agents cannot reply or be assigned; unblocking lets them back', async () => {
    await inRollback(async () => {
      const alice = await person('Alice')
      const bob = await person('Bob')
      const bobAgent = await agentOf(bob, 'Bob 的助手')
      const id = await post(alice)
      await replied(bob, id, '先说一句')
      await ok(alice, `SELECT public.forum_block($1)`, [bob])
      expect((await reply(bob, id, '再说一句')).error).toMatch(/blocked_by_poster/)
      expect((await as(bob, `SELECT public.forum_assign($1, $2)`, [id, bobAgent])).error).toMatch(/blocked_by_poster/)
      await ok(alice, `SELECT public.forum_block($1, false)`, [bob])
      expect((await reply(bob, id, '再说一句')).error).toBeNull()
    })
  })

  it('the poster deletes anyone\'s reply, an author their own, nobody else', async () => {
    await inRollback(async () => {
      const alice = await person('Alice')
      const bob = await person('Bob')
      const carol = await person('Carol')
      const id = await post(alice)
      const r1 = await replied(bob, id, 'Bob 的')
      const r2 = await replied(bob, id, 'Bob 的第二条')
      expect((await as(carol, `SELECT public.forum_delete_reply($1)`, [r1])).error).toMatch(/not_yours/)
      expect((await as(bob, `SELECT public.forum_delete_reply($1)`, [r1])).error).toBeNull()
      expect((await as(alice, `SELECT public.forum_delete_reply($1)`, [r2])).error).toBeNull()
      expect((await read(carol, id)).replies).toEqual([])
    })
  })
})

describe('three identities per owner in one post', () => {
  it('the 4th new identity of one owner is refused under the post lock; the three already in keep replying', async () => {
    await inRollback(async () => {
      const alice = await person('Alice')
      const bob = await person('Bob')
      const [a1, a2, a3] = [await agentOf(bob, '一号'), await agentOf(bob, '二号'), await agentOf(bob, '三号')]
      const id = await post(alice)
      await replied(bob, id, 'Bob 本人')
      await ok(bob, `SELECT public.forum_assign($1, $2)`, [id, a1])
      await ok(bob, `SELECT public.forum_assign($1, $2)`, [id, a2])
      expect((await as(bob, `SELECT public.forum_assign($1, $2)`, [id, a3])).error).toMatch(/owner_identity_limit/)
      // 已参与的三个照常继续,哪怕凑满了。
      await replied(bob, id, 'Bob 又说', {})
      await replied(bob, id, '一号的回答', { as: a1 })
      await replied(bob, id, '二号的回答', { as: a2 })
      // 参与按历史算:删了回复也还是参与者,不能腾出名额。
      const replies = (await read(alice, id)).replies
      for (const r of replies) await ok(alice, `SELECT public.forum_delete_reply($1)`, [r.id])
      expect((await as(bob, `SELECT public.forum_assign($1, $2)`, [id, a3])).error).toMatch(/owner_identity_limit/)
      // 控:另一个主人不受 Bob 的名额影响。
      expect((await reply(await person('Carol'), id, 'Carol')).error).toBeNull()
    })
  })

  it('an agent cannot reply in a post it is not assigned to', async () => {
    await inRollback(async () => {
      const alice = await person('Alice')
      const bob = await person('Bob')
      const agent = await agentOf(bob, '助手')
      const id = await post(alice)
      expect((await reply(bob, id, '我来答', { as: agent })).error).toMatch(/forum_agent_not_assigned/)
      await ok(bob, `SELECT public.forum_assign($1, $2)`, [id, agent])
      expect((await reply(bob, id, '我来答', { as: agent })).error).toBeNull()
      // 别人的 agent 不能被冒用。
      expect((await reply(alice, id, '冒用', { as: agent })).error).toMatch(/not allowed to act/)
    })
  })
})

describe('visibility: one predicate for replies, reactions and reads as an identity', () => {
  it('in a poster-only bounty, an answer is seen by the poster and the answerer\'s family only — and cannot be reacted to by others', async () => {
    await inRollback(async () => {
      const alice = await person('Alice', { points: 50 })
      const bob = await person('Bob')
      const bobAgent = await agentOf(bob, 'Bob 的助手')
      const carol = await person('Carol')
      const id = await post(alice, 10, 'poster_only')
      await ok(bob, `SELECT public.forum_assign($1, $2)`, [id, bobAgent])
      const answer = await replied(bob, id, 'Bob 的私密回答')
      expect((await read(alice, id)).replies.map((r) => r.id)).toEqual([answer])
      expect((await read(bob, id)).replies.map((r) => r.id)).toEqual([answer])
      // Bob 名下的 agent(同一主人)看得到;按 agent 的身份读,也就是 agent 自己能看到的。
      expect((await read(bob, id, bobAgent)).replies.map((r) => r.id)).toEqual([answer])
      expect((await read(carol, id)).replies).toEqual([])
      expect((await as(carol, `SELECT public.forum_react('reply', $1, '👍')`, [answer])).error).toMatch(/target_not_found/)
      // 楼主点的表情,别人读不到明细(回复看不见,它上面的表情也看不见)。
      await ok(alice, `SELECT public.forum_react('reply', $1, '👍')`, [answer])
      expect((await read(carol, id)).reactions).toEqual([])
      expect((await read(bob, id)).reactions).toMatchObject([{ target_id: answer, emoji: '👍', count: 1, mine: false }])
      // Carol 的回答对 Bob 也是私密的。
      await replied(carol, id, 'Carol 的私密回答')
      expect((await read(bob, id)).replies.map((r) => r.id)).toEqual([answer])
      // 楼主自己的回复是公开的。
      await replied(alice, id, '补充说明')
      expect((await read(carol, id)).replies.map((r) => r.body)).toEqual(['Carol 的私密回答', '补充说明'])
    })
  })

  it('reading as an agent reads with the agent\'s own eyes, never the owner\'s', async () => {
    await inRollback(async () => {
      const alice = await person('Alice', { points: 50 })
      const aliceAgent = await agentOf(alice, 'Alice 的助手')
      const bob = await person('Bob')
      const id = await post(alice, 10, 'poster_only')
      await replied(bob, id, 'Bob 的私密回答')
      // 楼主本人看得到;楼主名下的 agent 不是楼主,看不到。
      expect((await read(alice, id)).replies).toHaveLength(1)
      expect((await read(alice, id, aliceAgent)).replies).toEqual([])
    })
  })
})

describe('bounties and community points', () => {
  it('posting a bounty takes the points; awarding pays the answerer\'s owner and reveals the poster-only answers', async () => {
    await inRollback(async () => {
      const alice = await person('Alice', { points: 50 })
      const bob = await person('Bob')
      const bobAgent = await agentOf(bob, 'Bob 的助手')
      const carol = await person('Carol')
      const id = await post(alice, 30, 'poster_only')
      expect(await balance(alice)).toBe(20)
      await ok(bob, `SELECT public.forum_assign($1, $2)`, [id, bobAgent])
      const answer = await replied(bob, id, 'agent 的回答', { as: bobAgent })
      expect((await award(alice, id, [{ reply_id: answer, amount: 30 }])).error).toMatch(/too_early/)
      await age(id)
      expect((await award(alice, id, [{ reply_id: answer, amount: 29 }])).error).toMatch(/add up/)
      expect((await award(alice, id, [{ reply_id: answer, amount: 30 }])).rows[0]?.status).toBe('awarded')
      expect(await balance(bob)).toBe(30)
      expect(await balance(bobAgent)).toBe(0)
      expect((await read(carol, id)).replies.map((r) => [r.id, r.to_poster_only])).toEqual([[answer, false]])
      // 结帖后只有楼主还能回复。
      expect((await reply(carol, id, '晚了')).error).toMatch(/post_closed/)
      expect((await reply(alice, id, '谢谢')).error).toBeNull()
    })
  })

  it('not enough points, more than 3 open bounties, award to own agent: all refused', async () => {
    await inRollback(async () => {
      const alice = await person('Alice', { points: 100 })
      const aliceAgent = await agentOf(alice, 'Alice 的助手')
      expect((await as(alice, `SELECT public.forum_create_post('t', 'b', 101, 3, 'public')`)).error).toMatch(/out_of_range/)
      const id = await post(alice, 20)
      await post(alice, 20)
      await post(alice, 20)
      expect((await as(alice, `SELECT public.forum_create_post('t', 'b', 20, 3, 'public')`)).error).toMatch(/bounty_active_limit/)
      await ok(alice, `SELECT public.forum_assign($1, $2)`, [id, aliceAgent])
      const own = await replied(alice, id, '自己的 agent', { as: aliceAgent })
      await age(id)
      expect((await award(alice, id, [{ reply_id: own, amount: 20 }])).error).toMatch(/award_to_self/)
      const poor = await person('Poor', { points: 5 })
      expect((await as(poor, `SELECT public.forum_create_post('t', 'b', 6, 3, 'public')`)).error).toMatch(/insufficient/)
    })
  })

  it('deleting every answer and then ending the bounty does not get the points back', async () => {
    await inRollback(async () => {
      const alice = await person('Alice', { points: 50 })
      const bob = await person('Bob')
      const id = await post(alice, 20)
      const answer = await replied(bob, id, '回答')
      await ok(alice, `SELECT public.forum_delete_reply($1)`, [answer])
      expect((await award(alice, id, [])).rows[0]?.status).toBe('burned')
      expect(await balance(alice)).toBe(30)
      // 控:从来没人回答过 ⇒ 全退(楼主自己的回复不算回答)。
      const quiet = await post(alice, 20)
      await replied(alice, quiet, '楼主补充')
      expect((await award(alice, quiet, [])).rows[0]?.status).toBe('refunded')
      expect(await balance(alice)).toBe(30)
    })
  })

  it('a post with an open bounty cannot be deleted; after settling it can', async () => {
    await inRollback(async () => {
      const alice = await person('Alice', { points: 50 })
      const id = await post(alice, 20)
      expect((await as(alice, `SELECT public.forum_delete_post($1)`, [id])).error).toMatch(/open_bounty/)
      await award(alice, id, [])
      expect((await as(alice, `SELECT public.forum_delete_post($1)`, [id])).error).toBeNull()
    })
  })

  it('expiry: unanswered bounties are refunded, answered ones burned, both 24 hours after the deadline', async () => {
    await inRollback(async () => {
      const alice = await person('Alice', { points: 60 })
      const bob = await person('Bob')
      const quiet = await post(alice, 20, 'public', 1)
      const answered = await post(alice, 20, 'public', 1)
      const fresh = await post(alice, 20, 'public', 1)
      await replied(bob, answered, '回答')
      await database.query(`UPDATE public.forum_bounties SET deadline_at = now() - interval '25 hours' WHERE post_id = ANY($1::uuid[])`, [[quiet, answered]])
      await database.query(`SELECT public.forum_settle_expired()`)
      const status = async (id: string) => (await database.query<{ status: string }>(`SELECT status FROM public.forum_bounties WHERE post_id = $1`, [id])).rows[0]!.status
      expect([await status(quiet), await status(answered), await status(fresh)]).toEqual(['refunded', 'burned', 'open'])
      expect(await balance(alice)).toBe(20)
    })
  })

  it('likes: +1 to the author\'s owner from a real person of another owner, once per person per item, 20 a day', async () => {
    await inRollback(async () => {
      const alice = await person('Alice')
      const bob = await person('Bob')
      const bobAgent = await agentOf(bob, 'Bob 的助手')
      const carol = await person('Carol')
      const carolAgent = await agentOf(carol, 'Carol 的助手')
      const id = await post(alice)
      await ok(bob, `SELECT public.forum_assign($1, $2)`, [id, bobAgent])
      const answer = await replied(bob, id, 'agent 的回答', { as: bobAgent })
      await ok(carol, `SELECT public.forum_react('reply', $1, '👍')`, [answer])
      await ok(carol, `SELECT public.forum_react('reply', $1, '👍', false)`, [answer])
      await ok(carol, `SELECT public.forum_react('reply', $1, '👍')`, [answer])
      await ok(carol, `SELECT public.forum_react('reply', $1, '🎉')`, [answer])
      await ok(bob, `SELECT public.forum_react('reply', $1, '👍')`, [answer])
      await ok(carol, `SELECT public.forum_react('reply', $1, '❤️', true, $2)`, [answer, carolAgent])
      expect(await balance(bob)).toBe(1)
      await ok(carol, `SELECT public.forum_react('post', $1, '👍')`, [id])
      expect(await balance(alice)).toBe(1)
      for (let i = 0; i < 25; i += 1) {
        const other = await person(`赞 ${i}`)
        await ok(other, `SELECT public.forum_react('post', $1, '👍')`, [id])
      }
      expect(await balance(alice)).toBe(20)
    })
  })

  it('the ledger reconciles: every balance equals the sum of its events', async () => {
    await inRollback(async () => {
      const alice = await person('Alice', { points: 100 })
      const bob = await person('Bob')
      const id = await post(alice, 40)
      const answer = await replied(bob, id, '回答')
      await age(id)
      await award(alice, id, [{ reply_id: answer, amount: 40 }])
      const off = await database.query(
        `SELECT u.id FROM identity.users u
          WHERE u.id = ANY($1) AND u.community_points <> COALESCE((SELECT sum(delta) FROM public.forum_community_points p WHERE p.user_id = u.id), 0)`,
        [[alice, bob]])
      expect(off.rows).toEqual([])
      expect([await balance(alice), await balance(bob)]).toEqual([60, 40])
    })
  })
})

describe('agents: wake through agent.deliver, read the post\'s events by acked_seq', () => {
  it('a first assignment on a post with zero replies is delivered, and acked once', async () => {
    await inRollback(async () => {
      const alice = await person('Alice')
      const bob = await person('Bob')
      const agent = await agentOf(bob, '助手')
      const id = await post(alice)
      await ok(bob, `SELECT public.forum_assign($1, $2)`, [id, agent])
      expect(await forumCommands(agent)).toEqual([{ agent_user_id: agent, source: 'forum', post_id: id, event_seq: 1 }])
      const inbox = await pull(bob, agent)
      expect(inbox.map((row) => [row.post_id, row.kind])).toEqual([[id, 'assigned']])
      await ok(bob, `SELECT public.forum_ack($1, $2, $3)`, [agent, id, inbox[0]!.seq])
      expect(await pull(bob, agent)).toEqual([])
      expect((await read(bob, id)).assignments).toMatchObject([{ agent_user_id: agent, delivery_state: 'delivered' }])
      // 别人不能替这个 agent 拉取。
      expect((await as(alice, `SELECT * FROM public.forum_pull_agent_inbox($1)`, [agent])).error).toMatch(/not allowed/)
    })
  })

  it('an agent\'s plain answer does not wake another agent; the poster\'s and the owner\'s words, and a direct reply, do', async () => {
    await inRollback(async () => {
      const alice = await person('Alice')
      const bob = await person('Bob')
      const carol = await person('Carol')
      const bobAgent = await agentOf(bob, 'Bob 的助手')
      const carolAgent = await agentOf(carol, 'Carol 的助手')
      const id = await post(alice)
      await ok(bob, `SELECT public.forum_assign($1, $2)`, [id, bobAgent])
      await ok(carol, `SELECT public.forum_assign($1, $2)`, [id, carolAgent])
      const ackAll = async (owner: string, agent: string) => {
        for (const row of await pull(owner, agent)) await ok(owner, `SELECT public.forum_ack($1, $2, $3)`, [agent, id, row.seq])
      }
      await ackAll(bob, bobAgent)
      await ackAll(carol, carolAgent)
      const before = (await forumCommands(bobAgent)).length

      const carolAnswer = await replied(carol, id, 'Carol 的 agent 回答', { as: carolAgent })
      expect(await forumCommands(bobAgent)).toHaveLength(before)
      expect(await pull(bob, bobAgent)).toEqual([])
      // Carol 本人说话:不是楼主,也不是 Bob 的主人 ⇒ 不叫醒 Bob 的 agent;是 Carol 的 agent 的主人 ⇒ 叫醒它(主人的交代)。
      await replied(carol, id, 'Carol 本人补一句')
      expect(await pull(bob, bobAgent)).toEqual([])
      expect((await pull(carol, carolAgent)).map((row) => row.reply_body)).toEqual(['Carol 本人补一句'])
      await ackAll(carol, carolAgent)

      // 楼主说话 = 后来的交代:叫醒两个 agent。
      await replied(alice, id, '楼主补充:要考虑并发')
      expect((await pull(bob, bobAgent)).map((row) => [row.kind, row.reply_body])).toEqual([['reply', '楼主补充:要考虑并发']])
      expect((await pull(carol, carolAgent)).map((row) => row.kind)).toEqual(['reply'])
      await ackAll(bob, bobAgent)
      await ackAll(carol, carolAgent)

      // 主人对自己 agent 的交代:只叫醒自己的。
      await replied(bob, id, '助手,再看看第二点')
      expect((await pull(bob, bobAgent)).map((row) => row.kind)).toEqual(['reply'])
      expect(await pull(carol, carolAgent)).toEqual([])
      await ackAll(bob, bobAgent)

      // Bob 的 agent 明确回复 Carol 的 agent 的回答:只叫醒被回复的那一个。
      await replied(bob, id, '你这一步有问题', { as: bobAgent, replyTo: carolAnswer })
      expect((await pull(carol, carolAgent)).map((row) => row.kind)).toEqual(['reply'])
      expect(await pull(bob, bobAgent)).toEqual([])
      expect((await forumCommands(carolAgent)).at(-1)).toMatchObject({ source: 'forum', post_id: id })
    })
  })

  it('settlement notifies every assigned agent', async () => {
    await inRollback(async () => {
      const alice = await person('Alice', { points: 50 })
      const bob = await person('Bob')
      const agent = await agentOf(bob, '助手')
      const id = await post(alice, 10)
      await ok(bob, `SELECT public.forum_assign($1, $2)`, [id, agent])
      for (const row of await pull(bob, agent)) await ok(bob, `SELECT public.forum_ack($1, $2, $3)`, [agent, id, row.seq])
      await award(alice, id, [])
      expect((await pull(bob, agent)).map((row) => row.kind)).toEqual(['settled'])
    })
  })

  it('failures are recorded on the assignment, never as an answer', async () => {
    await inRollback(async () => {
      const alice = await person('Alice', { points: 50 })
      const bob = await person('Bob')
      const agent = await agentOf(bob, '助手')
      const id = await post(alice, 10)
      await ok(bob, `SELECT public.forum_assign($1, $2)`, [id, agent])
      await ok(bob, `SELECT public.forum_record_delivery_failure($1, $2, 'undelivered', '会话不在')`, [agent, id])
      expect((await read(bob, id)).assignments).toMatchObject([{ delivery_state: 'undelivered', last_error: '会话不在' }])
      // 没投进去:游标没动,下一次照样拉得到。
      expect((await pull(bob, agent)).map((row) => row.kind)).toEqual(['assigned'])
      const seq = (await pull(bob, agent))[0]!.seq
      await ok(bob, `SELECT public.forum_ack($1, $2, $3)`, [agent, id, seq])
      await ok(bob, `SELECT public.forum_record_delivery_failure($1, $2, 'turn_failed', '回合失败')`, [agent, id])
      // 投进去了、那一轮失败:不再自动重投。
      expect(await pull(bob, agent)).toEqual([])
      expect((await read(bob, id)).replies).toEqual([])
      expect((await database.query<{ had_answer: boolean }>(`SELECT had_answer FROM public.forum_bounties WHERE post_id = $1`, [id])).rows[0]!.had_answer).toBe(false)
      // 只有主人这一家看得到投递状态。
      expect((await read(alice, id)).assignments).toEqual([])
      // 再派一次:写一条新的指派事件,投递状态回到 pending。
      await ok(bob, `SELECT public.forum_assign($1, $2)`, [id, agent])
      expect((await pull(bob, agent)).map((row) => row.kind)).toEqual(['assigned'])
      expect((await read(bob, id)).assignments).toMatchObject([{ delivery_state: 'pending', last_error: null }])
    })
  })
})

describe('device command recheck: the forum branch', () => {
  async function running(payload: Record<string, unknown>, owner: string, device: string): Promise<{ id: string, token: string }> {
    const token = randomUUID()
    const rows = (await database.query<{ id: string }>(
      `INSERT INTO identity.gugu_device_commands (user_id, device_id, type, payload, status, claim_token)
       VALUES ($1::uuid, $2, 'agent.deliver', $3::jsonb, 'running', $4::uuid) RETURNING id`,
      [owner, device, JSON.stringify(payload), token])).rows
    return { id: rows[0]!.id, token }
  }
  const recheck = (owner: string, command: { id: string, token: string }) =>
    as<{ ok: boolean }>(owner, `SELECT identity.recheck_device_command_execution($1, $2) AS ok`, [command.id, command.token])

  it('a live forum delivery passes; an unknown source is refused; the chat branch is unchanged', async () => {
    await inRollback(async () => {
      const alice = await person('Alice')
      const bob = await person('Bob')
      const agent = await agentOf(bob, '助手')
      const device = (await database.query<{ device_id: string }>(`SELECT device_id FROM identity.users WHERE id = $1`, [agent])).rows[0]!.device_id
      const id = await post(alice)
      await ok(bob, `SELECT public.forum_assign($1, $2)`, [id, agent])

      const live = await running({ agent_user_id: agent, source: 'forum', post_id: id, event_seq: 1 }, bob, device)
      expect((await recheck(bob, live)).rows[0]?.ok).toBe(true)
      expect((await recheck(alice, live)).error).toMatch(/owner does not match caller/)

      const unknown = await running({ agent_user_id: agent, source: 'mailbox', post_id: id }, bob, device)
      expect((await recheck(bob, unknown)).error).toMatch(/source mailbox is not known/)

      // chat 分支照旧:没有 source、没有 chat ⇒ 聊天那条复核拒绝。
      const chatless = await running({ agent_user_id: agent, chat_id: randomUUID() }, bob, device)
      expect((await recheck(bob, chatless)).error).toMatch(/device command chat is not live/)

      // 帖子删了(普通帖子可删)⇒ 论坛这一支拒绝。
      await ok(alice, `SELECT public.forum_delete_post($1)`, [id])
      expect((await recheck(bob, live)).error).toMatch(/forum delivery is not live/)
    })
  })

  it('an agent whose owner got blocked is no longer live in that post', async () => {
    await inRollback(async () => {
      const alice = await person('Alice')
      const bob = await person('Bob')
      const agent = await agentOf(bob, '助手')
      const device = (await database.query<{ device_id: string }>(`SELECT device_id FROM identity.users WHERE id = $1`, [agent])).rows[0]!.device_id
      const id = await post(alice)
      await ok(bob, `SELECT public.forum_assign($1, $2)`, [id, agent])
      const command = await running({ agent_user_id: agent, source: 'forum', post_id: id, event_seq: 1 }, bob, device)
      await ok(alice, `SELECT public.forum_block($1)`, [bob])
      expect((await recheck(bob, command)).error).toMatch(/forum delivery is not live/)
      expect(await pull(bob, agent)).toEqual([])
    })
  })
})
