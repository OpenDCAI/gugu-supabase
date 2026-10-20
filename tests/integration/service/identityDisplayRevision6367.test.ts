import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// nmhjklnm/gugu#6367:一个身份的显示资料(名字/头像/简介)变了,能看到它的人都收到 agent_changed
// (resource_key.agent_user_id = 这个身份)—— 本人(真人)、好友、同会话成员;陌生人收不到;
// 非显示列的写入不扇出;agent 行的所属人只收到所属人触发器那一条,不重复。

type Row = Record<string, unknown>
interface Db {
  connect(): Promise<void>
  end(): Promise<void>
  query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => Db
}

const [ALICE, BOB, CAROL, DAVE, OWNER, AGENT] = Array.from({ length: 6 }, () => randomUUID())
const DEVICE = `dev6367-${randomUUID()}`
const DM = randomUUID()
const GROUP = randomUUID()
const HUMANS = [ALICE, BOB, CAROL, DAVE, OWNER]
let db: Db
const q = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows

/** 每个收件人收到的、指向 subject 的 agent_changed 条数。 */
async function received(subject: string): Promise<Record<string, number>> {
  const rows = await q(
    `SELECT user_id, count(*)::int AS n FROM chat.account_revisions
      WHERE event = 'agent_changed' AND resource_key->>'agent_user_id' = $1 GROUP BY user_id`,
    [subject],
  )
  return Object.fromEntries(rows.map((r) => [r.user_id as string, r.n as number]))
}

beforeAll(async () => {
  const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('identityDisplayRevision6367 requires a disposable loopback database')
  }
  db = new Client({ connectionString: url })
  await db.connect()
  // 所属人要有 auth 行(设备外键);建 auth 行会顺带建出他的真人身份行。其余真人只要身份行。
  await q(`INSERT INTO auth.users (id, created_at) VALUES ($1, now())`, [OWNER])
  await q(`INSERT INTO identity.users (id, type, display_name)
    SELECT id, 'human', '6367 fixture' FROM unnest($1::text[]) AS id`, [HUMANS.filter((id) => id !== OWNER)])
  await q(`INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform)
    VALUES ($1, $2, '6367-dev', '6367-host', 'darwin')`, [DEVICE, OWNER])
  await q(`INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id)
    VALUES ($1, 'agent', '6367 agent', $2, $3)`, [AGENT, OWNER, DEVICE])
  // Alice ↔ Bob 是好友(只有好友关系,没有会话)
  const [lo, hi] = [ALICE, BOB].sort()
  await q(`INSERT INTO identity.friendships (user_a_id, user_b_id) VALUES ($1, $2)`, [lo, hi])
  // Alice 与 Carol 私聊;Carol、Owner、agent 在一个群里(Alice 不在)
  await q(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1, 'dm', NULL, $2), ($3, 'group', '6367 group', $4)`,
    [DM, ALICE, GROUP, CAROL])
  await q(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`, [DM, ALICE, CAROL])
  await q(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'member')`,
    [GROUP, CAROL, OWNER, AGENT])
})

afterAll(async () => {
  if (!db) return
  await q(`DELETE FROM chat.chats WHERE id = ANY($1::text[])`, [[DM, GROUP]])
  await q(`DELETE FROM identity.friendships WHERE user_a_id = ANY($1::text[]) OR user_b_id = ANY($1::text[])`, [HUMANS])
  await q(`DELETE FROM identity.users WHERE id = $1`, [AGENT])
  await q(`DELETE FROM identity.gugu_devices WHERE device_id = $1`, [DEVICE])
  await q(`DELETE FROM auth.users WHERE id = $1`, [OWNER])
  await q(`DELETE FROM identity.users WHERE id = ANY($1::text[])`, [HUMANS.filter((id) => id !== OWNER)])
  await q(`DELETE FROM chat.account_revision_heads WHERE user_id = ANY($1::text[])`, [[...HUMANS, AGENT]])
  await db.end()
})

describe('identity display change → agent_changed to every viewer (#6367)', () => {
  it('a human rename reaches self, friend and co-member, and nobody else', async () => {
    expect(await received(ALICE)).toEqual({})
    await q(`UPDATE identity.users SET display_name = 'renamed 6367' WHERE id = $1`, [ALICE])
    expect(await received(ALICE)).toEqual({ [ALICE]: 1, [BOB]: 1, [CAROL]: 1 })
  })

  it('avatar and bio changes publish; writing the same value or a non-display column does not', async () => {
    await q(`UPDATE identity.users SET avatar = 'https://example.test/a.png' WHERE id = $1`, [ALICE])
    await q(`UPDATE identity.users SET bio = 'hello' WHERE id = $1`, [ALICE])
    expect(await received(ALICE)).toEqual({ [ALICE]: 3, [BOB]: 3, [CAROL]: 3 })
    await q(`UPDATE identity.users SET avatar = 'https://example.test/a.png', display_name = 'renamed 6367' WHERE id = $1`, [ALICE])
    await q(`UPDATE identity.users SET onboarded_at = now() WHERE id = $1`, [ALICE])
    expect(await received(ALICE)).toEqual({ [ALICE]: 3, [BOB]: 3, [CAROL]: 3 })
  })

  it('an agent rename reaches its co-members; the owner gets exactly the owner-trigger revision; the agent itself gets none', async () => {
    // 所属人触发器在 agent 行插入时已经给所属人记过一条 —— 判的是这次改名带来的增量。
    const before = await received(AGENT)
    await q(`UPDATE identity.users SET display_name = 'agent renamed 6367' WHERE id = $1`, [AGENT])
    const after = await received(AGENT)
    const delta = Object.fromEntries(Object.entries(after).map(([k, n]) => [k, n - (before[k] ?? 0)]).filter(([, n]) => n !== 0))
    expect(delta).toEqual({ [OWNER]: 1, [CAROL]: 1 })
  })
})
