import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 公开桶(avatars、chat-media)不再对任何人开放 SELECT(迁移 *_public_buckets_select_own;gugu#7290 复核 f43066ee1 的旁支):
 * 存储 API 以调用者的身份查 storage.objects(list、remove 的 DELETE … RETURNING、upload 的 INSERT … RETURNING),
 * 这里按同一个身份查同一张表。看得见 = 删得了:自己或自己 agent 的目录、自己的朋友圈引用着的对象;别人的、anon 都看不见。
 * 公开读(按 URL)不经 RLS,在 mac1 上用真的存储 API 另测(证据见 PR)。每条用例 BEGIN…ROLLBACK,否定配正对照。
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient
let alice: string
let mallory: string

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asAnon() {
  await database.query('SET LOCAL role TO anon')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'anon' })])
}
async function asOwner() {
  await database.query('RESET role')
}
async function human(name: string): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@public-buckets-select.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  return id
}
async function agentOf(owner: string): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'public-buckets fixture','fixture','darwin') ON CONFLICT DO NOTHING`, [`dev-${owner}`, owner])
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, agent_public, device_id)
    VALUES ($1,'agent','Helper',$2,true,$3)`, [id, owner, `dev-${owner}`])
  return id
}
async function object(bucket: 'chat-media' | 'avatars', name: string): Promise<string> {
  await asOwner()
  await database.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ($1,$2)`, [bucket, name])
  return name
}
/** What `as` sees in a bucket — the rows the storage API's list would be built from. */
async function seen(as: string | 'anon', bucket: string, names: string[]): Promise<string[]> {
  if (as === 'anon') await asAnon()
  else await asUser(as)
  const { rows } = await database.query<{ name: string }>('SELECT name FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2) ORDER BY name', [bucket, names])
  await asOwner()
  return rows.map((row) => row.name)
}
/** remove(): DELETE … RETURNING, as the storage API runs it for `as` (it sets storage.allow_delete_query first —
 * storage.protect_delete refuses a direct delete otherwise). */
async function removed(as: string, bucket: string, name: string): Promise<number> {
  await asUser(as)
  await database.query("SELECT set_config('storage.allow_delete_query', 'true', true)")
  const { rowCount } = await database.query('DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2 RETURNING name', [bucket, name])
  await asOwner()
  return rowCount ?? 0
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('publicBucketsSelectOwn.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  alice = await human('Alice')
  mallory = await human('Mallory')
})
afterEach(async () => {
  if (!database) return
  try {
    await asOwner()
  } finally {
    await database.query('ROLLBACK')
  }
})

describe('chat-media:看得见 = 删得了', () => {
  it('自己的看得见、删得了;别人的、anon 都看不见、删不了', async () => {
    const mine = await object('chat-media', `${alice}/${randomUUID()}-a.png`)
    const theirs = await object('chat-media', `${mallory}/${randomUUID()}-m.png`)
    expect(await seen(alice, 'chat-media', [mine, theirs])).toEqual([mine])
    expect(await seen(mallory, 'chat-media', [mine, theirs])).toEqual([theirs])
    expect(await seen('anon', 'chat-media', [mine, theirs])).toEqual([])
    expect(await removed(mallory, 'chat-media', mine)).toBe(0)
    expect(await removed(alice, 'chat-media', mine)).toBe(1)
  })

  it('主人看得见、删得了自己 agent 目录里的;别人的 agent 的看不见', async () => {
    const helper = await agentOf(alice)
    const strangers = await agentOf(mallory)
    const helpers = await object('chat-media', `${helper}/${randomUUID()}-h.png`)
    const other = await object('chat-media', `${strangers}/${randomUUID()}-s.png`)
    expect(await seen(alice, 'chat-media', [helpers, other])).toEqual([helpers])
    expect(await removed(alice, 'chat-media', helpers)).toBe(1)
  })

  it('朋友圈:贴主看得见、删得了朋友评论里的图(引用着的才算);没引用着的仍看不见', async () => {
    const post = randomUUID()
    const comment = randomUUID()
    const commentImage = await object('chat-media', `${mallory}/${randomUUID()}-c.png`)
    const unrelated = await object('chat-media', `${mallory}/${randomUUID()}-u.png`)
    await asOwner()
    await database.query(`INSERT INTO moments.posts (id, user_id) VALUES ($1,$2)`, [post, alice])
    await database.query(`INSERT INTO moments.post_comments (id, post_id, user_id, content) VALUES ($1,$2,$3,'nice')`, [comment, post, mallory])
    await database.query(`INSERT INTO moments.comment_media (id, comment_id, url, media_type, storage_bucket_id, storage_object_name)
      VALUES ($1,$2,'https://x.invalid/c.png','image','chat-media',$3)`, [randomUUID(), comment, commentImage])
    expect(await seen(alice, 'chat-media', [commentImage, unrelated])).toEqual([commentImage])
    expect(await removed(alice, 'chat-media', commentImage)).toBe(1)
  })
})

describe('avatars:看得见 = 删得了', () => {
  it('自己名下的(自己的头像、自己 agent 的头像)看得见、删得了;别人的、anon 都看不见', async () => {
    const helper = await agentOf(alice)
    const own = await object('avatars', `${alice}.png`)
    const helpers = await object('avatars', `${alice}.${helper}-${randomUUID()}.png`)
    const theirs = await object('avatars', `${mallory}.png`)
    expect(await seen(alice, 'avatars', [own, helpers, theirs])).toEqual([own, helpers].sort())
    expect(await seen(mallory, 'avatars', [own, helpers, theirs])).toEqual([theirs])
    expect(await seen('anon', 'avatars', [own, helpers, theirs])).toEqual([])
    expect(await removed(mallory, 'avatars', own)).toBe(0)
    expect(await removed(alice, 'avatars', helpers)).toBe(1)
  })
})
