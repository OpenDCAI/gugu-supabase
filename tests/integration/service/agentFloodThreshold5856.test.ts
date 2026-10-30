// @@@5856 「agent 超过几个转 passive」这条线 —— 对着**真库**跑的判官。
//
// owner 2026-09-19 的裁决(覆盖 spec 里记下的写死的 5):
//   「之前说是 5 个转为 passive, 这个数字可以放在设置中,而不是硬编码。
//     这个 5 个的 passive 不止可以适用于一个群内,群内的 topic 应该也是生效的,
//     不过群内的 topic 可以设置一个自定义个不一样的数,或者遵循群主规则。」
//
// 为什么非有这个文件不可:这条规则整个活在 DB 触发器里(改档位、发系统消息、落台账、落闸门),
// 界面这一侧只是填一个数。规则本身没有任何判官 —— 上一版连「话题被整条排除」这么大的洞
// 都没有东西能变红。
//
// 与 topicAccessControl5856 同形:loopback PostgreSQL、`GUGU_INTEGRATION_DATABASE_URL`,
// 在 .github/ci-spec-coverage.json 里登记为 loopback-postgres-integration。
// 跑法:`GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:34890/postgres \
//        pnpm exec vitest run agentFloodThreshold5856`
//
// 顺序用例 BEGIN…ROLLBACK;并发用例提交共享夹具并在 finally 清理。每条否定断言都配正对照。
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
const DATABASE_URL = (
  process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? ''
).trim()

let database: DatabaseClient

function requireLoopbackDatabase(): void {
  let parsed: URL
  try {
    parsed = new URL(DATABASE_URL)
  } catch {
    throw new Error('GUGU_INTEGRATION_DATABASE_URL is required')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`agentFloodThreshold5856.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`agentFloodThreshold5856.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
}

/** 一个合法的十六进制 uuid —— auth.uid() 按 uuid 解析,随便编的字符串会在函数入口就炸。 */
function uid(tag: string, n: number): string {
  const head = tag.padEnd(8, '0').slice(0, 8).replace(/[^0-9a-f]/g, '0')
  return `${head}-bbbb-4000-8000-${String(n).padStart(12, '0')}`
}

async function asUser(userId: string): Promise<void> {
  await database.query('SET LOCAL role TO authenticated')
  await database.query(`SET LOCAL request.jwt.claims TO '{"sub":"${userId}","role":"authenticated"}'`)
}
async function asService(): Promise<void> {
  await database.query('RESET role')
}

beforeAll(async () => {
  requireLoopbackDatabase()
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})
afterAll(async () => { await database?.end() })

async function inRollback(body: () => Promise<void>): Promise<void> {
  await database.query('BEGIN')
  try {
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

async function rejection(sql: string, values: unknown[]): Promise<string> {
  await database.query('SAVEPOINT probe')
  try {
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT probe')
    return String((error as Error)?.message ?? error)
  }
  await database.query('RELEASE SAVEPOINT probe')
  throw new Error(`expected this to be rejected, but it succeeded: ${sql}`)
}

interface Room { owner: string; group: string; topic: string; sourceMessage: string; agents: string[] }

/**
 * 一个群 + 一条从群里某条消息长出来的话题,群主两边都是 owner,外加 8 个待命的 agent。
 * agent 先建好但**先不入任何线** —— 触发器的时机就是「入线」,由每条用例自己决定什么时候放几个进去。
 */
async function seedRoom(tag: string): Promise<Room> {
  const owner = uid(tag, 1)
  const group = uid(tag, 11)
  const topic = uid(tag, 12)
  const sourceMessage = uid(tag, 21)
  const device = `dev-flood-${tag}`
  await database.query(
    `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform)
     VALUES ($1, $2, 'flood', 'flood', 'darwin')`,
    [device, owner],
  )
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','群主')`, [owner])
  const agents: string[] = []
  for (let index = 0; index < 8; index += 1) {
    const agent = uid(tag, 100 + index)
    agents.push(agent)
    await database.query(
      // agent 必有主人:群主直插自己的 agent(别人的 / 无主的 agent 会被 group_add_denial 按归属拒)。
      `INSERT INTO identity.users (id, type, display_name, device_id, owner_user_id) VALUES ($1,'agent',$2,$3,$4)`,
      [agent, `A${index + 1}`, device, owner],
    )
  }
  await database.query(
    `INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','群',$2)`,
    [group, owner],
  )
  await database.query(
    `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type)
     VALUES ($1,$2,$3,1,'源消息','text')`,
    [sourceMessage, group, owner],
  )
  await database.query(
    `INSERT INTO chat.chats (id, kind, name, creator_user_id, source_chat_id, source_message_id)
     VALUES ($1,'topic','话题',$2,$3,$4)`,
    [topic, owner, group, sourceMessage],
  )
  await database.query(
    `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$3,'owner'),($2,$3,'owner')`,
    [group, topic, owner],
  )
  return { owner, group, topic, sourceMessage, agents }
}

/** 往一条线里放 n 个 agent(一行一行插,与产品里真实的入线时机一致 —— 触发器是 FOR EACH ROW)。 */
async function joinAgents(chatId: string, agents: string[], n: number): Promise<void> {
  for (const agent of agents.slice(0, n)) {
    await database.query(
      `INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode) VALUES ($1,$2,'member','active')`,
      [chatId, agent],
    )
  }
}

async function listenModes(chatId: string): Promise<string[]> {
  const { rows } = await database.query<{ listen_mode: string }>(
    `SELECT cm.listen_mode FROM chat.chat_members cm
     JOIN identity.users u ON u.id = cm.user_id AND u.type = 'agent'
     WHERE cm.chat_id = $1 ORDER BY cm.user_id`,
    [chatId],
  )
  return rows.map((row) => row.listen_mode)
}

async function systemMessages(chatId: string): Promise<string[]> {
  const { rows } = await database.query<{ content: string }>(
    // #6386 起入群也会落一行系统消息(「X 加入了群聊」);这里只数调档那一条。
    `SELECT content FROM chat.messages
     WHERE chat_id = $1 AND content_type = 'system' AND client_message_id LIKE 'agent-flood:%'
     ORDER BY created_at`,
    [chatId],
  )
  return rows.map((row) => row.content)
}

/** 台账里记了几个人 —— 「全部撤回」照着它还原,漏一个就是撤了一半。 */
async function changedCount(chatId: string): Promise<number[]> {
  const { rows } = await database.query<{ n: number }>(
    `SELECT jsonb_array_length(changed) AS n FROM chat.agent_flood_adjustments
     WHERE chat_id = $1 ORDER BY created_at`,
    [chatId],
  )
  return rows.map((row) => Number(row.n))
}

async function effective(chatId: string): Promise<number | null> {
  const { rows } = await database.query<{ n: number | null }>(
    `SELECT chat.agent_flood_threshold_for($1) AS n`, [chatId],
  )
  return rows[0]?.n ?? null
}

describe('#5856 agent 数量线:可设置、群与话题都生效(对着真库跑)', () => {
  // #5997 成员选择器并发发送单人 INSERT。两条连接必须各自持有事务,否则逐个 await 的
  // joinAgents 永远看不到「两边都以为自己还没过线」以及重复调整消息这两种竞争。
  it.each([
    { tag: 'c1', line: 'group' as const, initial: 4 },
    { tag: 'c2', line: 'group' as const, initial: 5 },
    { tag: 'c3', line: 'topic' as const, initial: 4 },
  ])('并发入 $line:已有 $initial 个 agent,两次加入合计过线仍只调整一次', async ({ tag, line, initial }) => {
    const first = new Client({ connectionString: DATABASE_URL })
    const second = new Client({ connectionString: DATABASE_URL })
    await Promise.all([first.connect(), second.connect()])
    let room: Room | undefined
    let pending: Promise<QueryResult<never>> | undefined
    try {
      await database.query('BEGIN')
      room = await seedRoom(tag)
      // 与 rollback-only 用例不同,跨连接前要提交夹具,设备对 auth.users 的延迟外键必须真实成立。
      await database.query('INSERT INTO auth.users (id, created_at) VALUES ($1, now())', [room.owner])
      // 话题成员必须先在来源群内。来源群调高阈值,避免其调整干扰被测话题。
      if (line === 'topic') {
        await database.query('UPDATE chat.chats SET agent_flood_threshold = 10 WHERE id = $1', [room.group])
        await joinAgents(room.group, room.agents, 8)
        await database.query('UPDATE chat.chats SET agent_flood_threshold = 5 WHERE id = $1', [room.topic])
      }
      const chatId = room[line]
      await joinAgents(chatId, room.agents, initial)
      await database.query('COMMIT')
      expect(await listenModes(chatId)).toEqual(Array(initial).fill('active'))
      expect(await systemMessages(chatId)).toHaveLength(0)

      for (const client of [first, second]) {
        await client.query('BEGIN')
        await client.query('SET LOCAL statement_timeout = 10000')
        await client.query('SET LOCAL role TO authenticated')
        await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: room.owner, role: 'authenticated' })])
      }
      const { rows: pids } = await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const pid = pids[0]!.pid
      const insert = 'SELECT chat.add_group_agent($1,$2,NULL,auth.uid()::text)'
      await first.query(insert, [chatId, room.agents[initial]])
      let settled = false
      pending = second.query(insert, [chatId, room.agents[initial + 1]])
      void pending.then(() => { settled = true }, () => { settled = true })

      // 确认第二条 INSERT 已运行:旧实现会完成(漏计数)或在较晚的 UPDATE 上等锁(重复消息),
      // 修复后则在计数之前等群行锁。只用固定延迟会把「请求还没到库」当作成功串行化。
      await expect.poll(async () => {
        const { rows } = await database.query<{ blocked: boolean }>(
          `SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked`, [pid],
        )
        return settled || rows[0]?.blocked
      }, { timeout: 5000 }).toBe(true)
      await first.query('COMMIT')
      await pending
      await second.query('COMMIT')

      expect(await listenModes(chatId)).toEqual(Array(initial + 2).fill('passive'))
      expect(await systemMessages(chatId)).toHaveLength(1)
      expect(await changedCount(chatId)).toEqual([initial + 2])
    } finally {
      await first.query('ROLLBACK')
      await pending?.catch(() => undefined)
      await second.query('ROLLBACK')
      await Promise.all([first.end(), second.end()])
      await database.query('ROLLBACK')
      if (room) {
        await database.query('DELETE FROM chat.chats WHERE id = ANY($1::text[])', [[room.topic, room.group]])
        await database.query('DELETE FROM identity.users WHERE id = ANY($1::text[])', [room.agents])
        await database.query('DELETE FROM identity.gugu_devices WHERE device_id = $1', [`dev-flood-${tag}`])
        // auth 删除触发器负责清理 human identity;先手删 identity 会被生命周期约束拒绝。
        await database.query('DELETE FROM auth.users WHERE id = $1', [room.owner])
      }
    }
  })

  it('不填就是产品默认 5:第 5 个 agent 进群不动,第 6 个才动', async () => {
    await inRollback(async () => {
      const room = await seedRoom('b1')
      expect(await effective(room.group)).toBe(5)

      await joinAgents(room.group, room.agents, 5)
      // 阴控:正好 5 个是「不超过」,一个都不许动 —— spec 的字面是「超过 5 个」。
      expect(await listenModes(room.group)).toEqual(['active', 'active', 'active', 'active', 'active'])
      expect(await systemMessages(room.group)).toEqual([])

      await joinAgents(room.group, room.agents.slice(5), 1)
      // 阳控:第 6 个进来就过线,全员转 passive 并落一条系统消息。
      expect(await listenModes(room.group)).toEqual(Array(6).fill('passive'))
      expect(await systemMessages(room.group)).toHaveLength(1)
    })
  })

  it('群里填的数说了算:设成 2 之后第 3 个 agent 就触发,消息里写的是这个数', async () => {
    await inRollback(async () => {
      const room = await seedRoom('b2')
      await database.query(`UPDATE chat.chats SET agent_flood_threshold = 2 WHERE id = $1`, [room.group])
      expect(await effective(room.group)).toBe(2)

      await joinAgents(room.group, room.agents, 2)
      expect(await listenModes(room.group)).toEqual(['active', 'active'])

      await joinAgents(room.group, room.agents.slice(2), 1)
      expect(await listenModes(room.group)).toEqual(['passive', 'passive', 'passive'])
      const [message] = await systemMessages(room.group)
      // owner 2026-09-19:「就提示个群人数较多,agent 转为被动模式就行了.你还一个一个点名」——
      // 正文只说一句,❌ 不许出现任何一个 agent 的名字(名单只进台账,给「一键全撤」用)。
      expect(message).toContain('转为被动模式')
      expect(message).not.toContain('A1')
      expect(message).not.toContain('A2')
      expect(message).not.toContain('A3')
      // 线本身生效与否由行为判:2 个不动、第 3 个才动(上面两句断言),台账记下的是当时的真实个数。
      const { rows } = await database.query<{ agent_count: number }>(
        `SELECT agent_count FROM chat.agent_flood_adjustments WHERE chat_id = $1`, [room.group],
      )
      expect(rows.map((row) => row.agent_count)).toEqual([3])
    })
  })

  it('「遵循群主规则」:话题不填就跟着来源那条线走,并且话题里也真的会触发', async () => {
    await inRollback(async () => {
      const room = await seedRoom('b3')
      await database.query(`UPDATE chat.chats SET agent_flood_threshold = 2 WHERE id = $1`, [room.group])
      expect(await effective(room.topic)).toBe(2)

      await joinAgents(room.topic, room.agents, 3)
      // 上一版这里是全 active:触发器第一句 `kind IS DISTINCT FROM 'group'` 把话题整条排除了。
      expect(await listenModes(room.topic)).toEqual(['passive', 'passive', 'passive'])
      expect((await systemMessages(room.topic))[0]).toContain('这条话题')
      // 阴控:动的只有话题这一条线,来源群没被顺手改掉。
      expect(await systemMessages(room.group)).toEqual([])
    })
  })

  it('话题填了自己的数就压过群的数:群 2 / 话题 4,话题里 3 个 agent 不动而群里 3 个动', async () => {
    await inRollback(async () => {
      const room = await seedRoom('b4')
      await database.query(`UPDATE chat.chats SET agent_flood_threshold = 2 WHERE id = $1`, [room.group])
      await database.query(`UPDATE chat.chats SET agent_flood_threshold = 4 WHERE id = $1`, [room.topic])
      expect(await effective(room.topic)).toBe(4)

      await joinAgents(room.topic, room.agents, 3)
      expect(await listenModes(room.topic)).toEqual(['active', 'active', 'active'])

      // 阳控:同一批 agent 进群(线是 2)就该被改 —— 证明上面那个「不动」是线的功劳,不是我没插进去。
      await joinAgents(room.group, room.agents, 3)
      expect(await listenModes(room.group)).toEqual(['passive', 'passive', 'passive'])
    })
  })

  it('改了这条线的数当场重新过一遍:设置不是等下一个 agent 进来才生效的死值', async () => {
    await inRollback(async () => {
      const room = await seedRoom('b5')
      await joinAgents(room.group, room.agents, 3)
      // 默认 5,3 个 agent 不过线。
      expect(await listenModes(room.group)).toEqual(['active', 'active', 'active'])

      await database.query(`UPDATE chat.chats SET agent_flood_threshold = 2 WHERE id = $1`, [room.group])
      expect(await listenModes(room.group)).toEqual(['passive', 'passive', 'passive'])
      expect(await systemMessages(room.group)).toHaveLength(1)

      // 闸门随之落下:再改一次**同一个值**不算改动(触发器带 IS DISTINCT FROM),什么都不该发生。
      await database.query(`UPDATE chat.chats SET agent_flood_threshold = 2 WHERE id = $1`, [room.group])
      expect(await systemMessages(room.group)).toHaveLength(1)
    })
  })

  it('撤回之后仍然是「只做一次」,但用户重新改一个数就是他自己下的新命令 ⇒ 重新武装', async () => {
    await inRollback(async () => {
      const room = await seedRoom('b6')
      await database.query(`UPDATE chat.chats SET agent_flood_threshold = 2 WHERE id = $1`, [room.group])
      await joinAgents(room.group, room.agents, 3)
      expect(await listenModes(room.group)).toEqual(['passive', 'passive', 'passive'])

      const { rows } = await database.query<{ id: string }>(
        `SELECT id FROM chat.agent_flood_adjustments WHERE chat_id = $1`, [room.group],
      )
      await asUser(room.owner)
      await database.query(`SELECT * FROM chat.undo_agent_flood_adjustment($1,auth.uid()::text)`, [rows[0]!.id])
      await asService()
      expect(await listenModes(room.group)).toEqual(['active', 'active', 'active'])

      // 阴控:撤完再进一个 agent,闸门仍然关着 —— spec 的「只做一次」没有被这条改动削弱。
      await joinAgents(room.group, room.agents.slice(3), 1)
      expect(await listenModes(room.group)).toEqual(['active', 'active', 'active', 'active'])
      expect(await systemMessages(room.group)).toHaveLength(1)

      // 阳控:他自己把线改成 3 ⇒ 重新武装并当场生效。
      await database.query(`UPDATE chat.chats SET agent_flood_threshold = 3 WHERE id = $1`, [room.group])
      expect(await listenModes(room.group)).toEqual(Array(4).fill('passive'))
      expect(await systemMessages(room.group)).toHaveLength(2)
    })
  })

  it('单聊不参与:kind 放宽到话题,❌ 没有顺手把两个人的线也卷进来', async () => {
    await inRollback(async () => {
      const room = await seedRoom('b7')
      const dm = uid('b7', 31)
      await database.query(
        `INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'dm',NULL,$2)`,
        [dm, room.owner],
      )
      await database.query(
        `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`,
        [dm, room.owner],
      )
      await database.query(`UPDATE chat.chats SET agent_flood_threshold = 1 WHERE id = $1`, [dm])
      await joinAgents(dm, room.agents, 3)
      expect(await listenModes(dm)).toEqual(['active', 'active', 'active'])
      expect(await systemMessages(dm)).toEqual([])
    })
  })

  it('这个数只对看得见这条线的人可读;界面读的计算列与触发器读的是同一个数', async () => {
    await inRollback(async () => {
      const room = await seedRoom('b8')
      const stranger = uid('b8', 41)
      await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','路人')`, [stranger])
      await database.query(`UPDATE chat.chats SET agent_flood_threshold = 7 WHERE id = $1`, [room.group])

      await asUser(stranger)
      // 阴控:第九轮那条纪律 —— DEFINER 的探针不许「传谁的 id 都行」。
      expect(await effective(room.group)).toBeNull()

      await asUser(room.owner)
      // 阳控:群主读得到,证明上面那个 null 是闸门而不是我上下文没设对。
      expect(await effective(room.group)).toBe(7)
      const { rows } = await database.query<{ own: number | null; eff: number }>(
        `SELECT agent_flood_threshold AS own, chat.agent_flood_threshold_effective(c) AS eff
         FROM chat.chats c WHERE c.id = $1`,
        [room.topic],
      )
      // 话题自己没填,计算列却要给出继承后的 7 —— 界面靠它显示「跟随来源」的实际数。
      expect(rows[0]).toEqual({ own: null, eff: 7 })
      await asService()
    })
  })

  it('存完之后回给界面的生效值必须是**新**值,❌ 不是语句开始时那个旧值', async () => {
    await inRollback(async () => {
      const room = await seedRoom('c1')
      // 这一格钉的是函数的易变性。声明成 STABLE 的话,它在一条语句里看到的是语句开始时的快照 ⇒
      // `UPDATE … RETURNING <生效值>` 回的是改之前的 5,界面存完原地显示旧值、要重开面板才对得上。
      const { rows } = await database.query<{ eff: number }>(
        `UPDATE chat.chats c SET agent_flood_threshold = 3 WHERE c.id = $1
         RETURNING chat.agent_flood_threshold_effective(c.*) AS eff`,
        [room.group],
      )
      expect(rows[0]?.eff).toBe(3)
    })
  })

  it('这个数至少是 1:0 被 CHECK 挡住,1 放行', async () => {
    await inRollback(async () => {
      const room = await seedRoom('b9')
      const message = await rejection(
        `UPDATE chat.chats SET agent_flood_threshold = 0 WHERE id = $1`, [room.group],
      )
      expect(message).toContain('chats_agent_flood_threshold_positive')
      await database.query(`UPDATE chat.chats SET agent_flood_threshold = 1 WHERE id = $1`, [room.group])
      expect(await effective(room.group)).toBe(1)
    })
  })
  // ── owner 2026-09-19 实测:「不是说全部转为被动吗? claude6 怎么还能回话」 ────────────────
  // 那个群里 助手一~五 是过线那次改的 passive,Claude 6 晚几小时才进群 ⇒ active,
  // 而「已把它们都转为被动模式」那条系统消息还挂在屏幕上。
  it('过线之后才进来的 agent 照样转 passive —— 规矩是这条线的,不是过线那一秒在场那几个的', async () => {
    await inRollback(async () => {
      const room = await seedRoom('d1')
      await database.query(`UPDATE chat.chats SET agent_flood_threshold = 2 WHERE id = $1`, [room.group])
      await joinAgents(room.group, room.agents, 3)
      expect(await listenModes(room.group)).toEqual(['passive', 'passive', 'passive'])
      expect(await changedCount(room.group)).toEqual([3])

      await joinAgents(room.group, room.agents.slice(3), 1)
      expect(await listenModes(room.group)).toEqual(Array(4).fill('passive'))
      // ❌ 不发第二条:规矩已经在屏幕上说过一遍,每进一个 agent 再说一遍就是刷屏。
      expect(await systemMessages(room.group)).toHaveLength(1)
      // 但它必须并进那条台账,否则「全部撤回」会漏下它 —— 撤完一半是比不撤更坏的状态。
      expect(await changedCount(room.group)).toEqual([4])

      const { rows } = await database.query<{ id: string }>(
        `SELECT id FROM chat.agent_flood_adjustments WHERE chat_id = $1`, [room.group],
      )
      await asUser(room.owner)
      await database.query(`SELECT * FROM chat.undo_agent_flood_adjustment($1,auth.uid()::text)`, [rows[0]!.id])
      await asService()
      // 阳控:一键全撤把**四个**都还原了,包括后来进来的那个。
      expect(await listenModes(room.group)).toEqual(Array(4).fill('active'))
      // 反例在 b6 那一格:撤回之后再进来的 agent 保持 active —— 用户说了不要,规矩就不作数了。
    })
  })

  it('用户手动调回 active 的那个,❌ 不会被下一个进来的人抹掉', async () => {
    await inRollback(async () => {
      const room = await seedRoom('d2')
      await database.query(`UPDATE chat.chats SET agent_flood_threshold = 2 WHERE id = $1`, [room.group])
      await joinAgents(room.group, room.agents, 3)
      // 用户进资料卡,把第一个调回「主动」。这是他的决定。
      await database.query(
        `UPDATE chat.chat_members SET listen_mode = 'active' WHERE chat_id = $1 AND user_id = $2`,
        [room.group, room.agents[0]],
      )

      await joinAgents(room.group, room.agents.slice(3), 1)
      // 新来的照办(阳控),他手动调过的那个原样不动(阴控)——
      // 入线这条路只管刚进来的那一个,❌ 不重扫全场。
      expect(await listenModes(room.group)).toEqual(['active', 'passive', 'passive', 'passive'])
    })
  })

  it('组队建群把档位按蓝图写回 active 之后,这条线的规矩仍然作数', async () => {
    await inRollback(async () => {
      const room = await seedRoom('d3')
      await database.query(`UPDATE chat.chats SET agent_flood_threshold = 2 WHERE id = $1`, [room.group])
      await joinAgents(room.group, room.agents, 3)
      expect(await listenModes(room.group)).toEqual(['passive', 'passive', 'passive'])

      // identity.finalize_agent_team 的形状:建群(逐行 INSERT 已经触发过规则、已经发了消息)之后,
      // 再按蓝图逐个把 listen_mode 写回去。组一个 6 人 agent 团队时蓝图里写的正是 active。
      await database.query(
        `UPDATE chat.chat_members cm SET listen_mode = 'active'
         WHERE cm.chat_id = $1 AND EXISTS (SELECT 1 FROM identity.users u WHERE u.id = cm.user_id AND u.type='agent')`,
        [room.group],
      )
      await database.query(`SELECT chat.enforce_agent_flood_passive($1)`, [room.group])
      expect(await listenModes(room.group)).toEqual(['passive', 'passive', 'passive'])
      expect(await systemMessages(room.group)).toHaveLength(1)

      // 阴控:没过过线的那条线(话题这里一个 agent 都没有、闸门没落过),enforce 不许动它。
      await joinAgents(room.topic, room.agents, 1)
      await database.query(`SELECT chat.enforce_agent_flood_passive($1)`, [room.topic])
      expect(await listenModes(room.topic)).toEqual(['active'])

      // 上面验的是这套规矩本身;finalize 真的会去调它,判在**装进库里的那份函数体**上。
      const { rows } = await database.query<{ def: string }>(
        `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'identity' AND p.proname = 'finalize_agent_team'`,
      )
      expect(rows[0]?.def).toContain('chat.enforce_agent_flood_passive(v_group_chat_id)')
    })
  })

})
