import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * identity.device_projects / identity.publish_device_projects (OpenDCAI/gugu#113): each device records its local
 * projects and their folders on the account; only the owner reads them, only the owner's device replaces them.
 * Every negative assertion has a positive control; every case runs inside BEGIN...ROLLBACK.
 * Run: `GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:<port>/postgres pnpm exec vitest run deviceProjects`
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient

type Folder = { workspace_id: string; kind: 'root' | 'attached'; path: string; attached_at: string | null }
type Project = {
  local_project_id: string; name: string; root_path: string; created_at: string; chat_id: string | null
  group_representative: boolean; folders: Folder[]
}
type Row = Project & { device_id: string; user_id: string }

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asAnon() {
  await database.query('SET LOCAL role TO anon')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'anon' })])
}
async function asService() { await database.query('RESET role') }
async function fails(sql: string, values?: unknown[]): Promise<string> {
  await database.query('SAVEPOINT expected_failure')
  try {
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT expected_failure')
    return String((error as Error).message)
  }
  await database.query('RELEASE SAVEPOINT expected_failure')
  throw new Error(`expected failure, but succeeded: ${sql}`)
}
async function account(): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@device-projects.invalid`])
  return id
}
async function device(owner: string): Promise<string> {
  await asService()
  const id = `device-projects-${randomUUID()}`
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'test','host','linux')`, [id, owner])
  return id
}
function project(id: string, folders: Folder[] = [], chat: string | null = null): Project {
  return {
    local_project_id: id,
    name: `Project ${id}`,
    root_path: `/home/me/${id}`,
    created_at: '2026-10-01T08:00:00+00:00',
    chat_id: chat,
    group_representative: false,
    folders: [{ workspace_id: `${id}-root`, kind: 'root', path: `/home/me/${id}`, attached_at: null }, ...folders],
  }
}
async function publish(owner: string, deviceId: string, projects: unknown): Promise<boolean> {
  await asUser(owner)
  const { rows } = await database.query<{ changed: boolean }>(
    'SELECT identity.publish_device_projects($1, $2::jsonb) AS changed', [deviceId, JSON.stringify(projects)])
  return rows[0]!.changed
}
async function read(asWho: string): Promise<Row[]> {
  await asUser(asWho)
  const { rows } = await database.query<Row>(`SELECT device_id, user_id::text, local_project_id, name, root_path,
    to_jsonb(created_at) #>> '{}' AS created_at, chat_id, group_representative, folders
    FROM identity.device_projects ORDER BY device_id, local_project_id`)
  return rows
}
async function deviceRevisions(owner: string, deviceId: string): Promise<number> {
  await asService()
  const { rows } = await database.query<{ n: string }>(`SELECT count(*) AS n FROM chat.account_revisions
    WHERE user_id = $1 AND event = 'device_changed' AND resource_key = jsonb_build_object('device_id', $2::text)`, [owner, deviceId])
  return Number(rows[0]!.n)
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('deviceProjects.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => { await database.query('BEGIN') })
afterEach(async () => {
  if (!database) return
  try {
    await asService()
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await database.query('ROLLBACK')
  }
})

describe('identity.publish_device_projects', () => {
  it('records the projects and folders of a device for its owner only (control: the owner reads them)', async () => {
    const owner = await account()
    const laptop = await device(owner)
    const attached: Folder = { workspace_id: 'wt', kind: 'attached', path: '/home/me/a-wt', attached_at: '2026-10-22T10:00:00.000Z' }
    expect(await publish(owner, laptop, [project('a', [attached], 'chat-a'), project('b')])).toBe(true)

    expect(await read(owner)).toEqual([
      { device_id: laptop, user_id: owner, ...project('a', [attached], 'chat-a') },
      { device_id: laptop, user_id: owner, ...project('b') },
    ])
    expect(await read(await account())).toEqual([])
  })

  it('lists the projects of every device of the account', async () => {
    const owner = await account()
    const [laptop, server] = [await device(owner), await device(owner)]
    await publish(owner, laptop, [project('a', [], 'shared')])
    await publish(owner, server, [project('a', [], 'shared'), project('c')])
    const rows = await read(owner)
    expect(rows.map((row) => `${row.device_id} ${row.local_project_id}`).sort())
      .toEqual([`${laptop} a`, `${server} a`, `${server} c`].sort())
  })

  it('replaces the device set: drops what is gone, updates what changed, adds what is new', async () => {
    const owner = await account()
    const laptop = await device(owner)
    const other = await device(owner)
    await publish(owner, laptop, [project('a'), project('b')])
    await publish(owner, other, [project('kept')])

    const renamed = { ...project('b', [], 'chat-b'), name: 'Renamed', group_representative: true }
    expect(await publish(owner, laptop, [renamed, project('c')])).toBe(true)
    const rows = await read(owner)
    expect(rows.filter((row) => row.device_id === laptop)
      .map(({ local_project_id, name, chat_id, group_representative }) => ({ local_project_id, name, chat_id, group_representative })))
      .toEqual([
        { local_project_id: 'b', name: 'Renamed', chat_id: 'chat-b', group_representative: true },
        { local_project_id: 'c', name: 'Project c', chat_id: null, group_representative: false },
      ])
    expect(rows.filter((row) => row.device_id === other).map((row) => row.local_project_id)).toEqual(['kept'])

    expect(await publish(owner, laptop, [])).toBe(true)
    expect((await read(owner)).map((row) => row.local_project_id)).toEqual(['kept'])
  })

  it('advances the account revision only when something changed (control: a change advances it)', async () => {
    const owner = await account()
    const laptop = await device(owner)
    const before = await deviceRevisions(owner, laptop)
    expect(await publish(owner, laptop, [project('a')])).toBe(true)
    expect(await deviceRevisions(owner, laptop)).toBe(before + 1)

    expect(await publish(owner, laptop, [project('a')])).toBe(false)
    expect(await deviceRevisions(owner, laptop)).toBe(before + 1)

    const folder: Folder = { workspace_id: 'x', kind: 'attached', path: '/srv/x', attached_at: null }
    expect(await publish(owner, laptop, [project('a', [folder])])).toBe(true)
    expect(await deviceRevisions(owner, laptop)).toBe(before + 2)
  })

  it('records a project without group_representative as not the representative', async () => {
    const owner = await account()
    const laptop = await device(owner)
    const { group_representative: _omitted, ...bare } = project('a', [], 'chat-a')
    await publish(owner, laptop, [bare])
    expect((await read(owner))[0]!.group_representative).toBe(false)
  })

  it('stores each folder with its four fields only', async () => {
    const owner = await account()
    const laptop = await device(owner)
    const folder = { workspace_id: 'x', kind: 'attached', path: '/srv/x', branch: 'main', sessionIds: ['s1'] }
    await publish(owner, laptop, [{ ...project('a'), folders: [folder] }])
    expect((await read(owner))[0]!.folders).toEqual([{ workspace_id: 'x', kind: 'attached', path: '/srv/x', attached_at: null }])
  })

  it("refuses another account's device (control: the owner's own device is accepted)", async () => {
    const owner = await account()
    const laptop = await device(owner)
    const stranger = await account()
    await asUser(stranger)
    expect(await fails('SELECT identity.publish_device_projects($1, $2::jsonb)', [laptop, JSON.stringify([project('a')])]))
      .toMatch(/not owned by current user/)
    await asUser(stranger)
    expect(await fails('SELECT identity.publish_device_projects($1, $2::jsonb)', ['no-such-device', '[]']))
      .toMatch(/not owned by current user/)
    expect(await publish(owner, laptop, [project('a')])).toBe(true)
  })

  it('refuses callers that are not signed in (control: a signed-in owner publishes)', async () => {
    const owner = await account()
    const laptop = await device(owner)
    await asAnon()
    expect(await fails('SELECT identity.publish_device_projects($1, $2::jsonb)', [laptop, '[]'])).toMatch(/permission denied/)
    await asAnon()
    expect(await fails('SELECT * FROM identity.device_projects')).toMatch(/permission denied/)
    expect(await publish(owner, laptop, [project('a')])).toBe(true)
  })

  it('keeps the table read-only to clients (control: the RPC writes it)', async () => {
    const owner = await account()
    const laptop = await device(owner)
    await asUser(owner)
    expect(await fails(`INSERT INTO identity.device_projects (device_id,user_id,local_project_id,name,root_path)
      VALUES ($1,$2,'x','x','/x')`, [laptop, owner])).toMatch(/permission denied/)
    await publish(owner, laptop, [project('a')])
    await asUser(owner)
    expect(await fails("UPDATE identity.device_projects SET name = 'x'")).toMatch(/permission denied/)
    await asUser(owner)
    expect(await fails('DELETE FROM identity.device_projects')).toMatch(/permission denied/)
    expect((await read(owner)).map((row) => row.name)).toEqual(['Project a'])
  })

  it('refuses malformed lists without changing the rows', async () => {
    const owner = await account()
    const laptop = await device(owner)
    await publish(owner, laptop, [project('a')])
    const bad: [unknown, RegExp][] = [
      [{ not: 'an array' }, /must be an array/],
      [[project('a'), project('a')], /published once/],
      [[{ ...project('a'), root_path: '' }], /Invalid project/],
      [[{ ...project('a'), local_project_id: 7 }], /Invalid project/],
      [[{ ...project('a'), chat_id: 7 }], /Invalid project/],
      [[{ ...project('a'), group_representative: 'yes' }], /Invalid project/],
      [[{ ...project('a'), folders: null }], /Invalid project/],
      [[{ ...project('a'), created_at: 'yesterday-ish' }], /Invalid project/],
      [[{ ...project('a'), created_at: undefined }], /Invalid project/],
      [[{ ...project('a'), folders: [{ workspace_id: 'x', kind: 'other', path: '/x' }] }], /Invalid folder/],
      [[{ ...project('a'), folders: [{ workspace_id: '', kind: 'root', path: '/x' }] }], /Invalid folder/],
      [[{ ...project('a'), folders: [{ workspace_id: 'x', kind: 'root', path: '/x', attached_at: 5 }] }], /Invalid folder/],
    ]
    for (const [projects, message] of bad) {
      await asUser(owner)
      expect(await fails('SELECT identity.publish_device_projects($1, $2::jsonb)', [laptop, JSON.stringify(projects)])).toMatch(message)
    }
    expect((await read(owner)).map((row) => row.local_project_id)).toEqual(['a'])
  })

  it('goes with its device', async () => {
    const owner = await account()
    const [laptop, server] = [await device(owner), await device(owner)]
    await publish(owner, laptop, [project('a')])
    await publish(owner, server, [project('b')])
    await asService()
    await database.query('DELETE FROM identity.gugu_devices WHERE device_id = $1', [laptop])
    expect((await read(owner)).map((row) => row.local_project_id)).toEqual(['b'])
  })
})
