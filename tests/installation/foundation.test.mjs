import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { foundationDigest, installFoundation, installReleases, releases } from '../../scripts/foundation.mjs'

// Deliberately requires an empty, disposable Supabase PostgreSQL 17 instance.
// Never resets schemas, migration history, or user data to make a test pass.
test('fresh foundation, repeat installation, authorization and refusal guards', async () => {
  const url = new URL(process.env.GUGU_INSTALL_TEST_DATABASE_URL ?? '')
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol))
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'installation tests require loopback PostgreSQL')
  const db = new pg.Client({ connectionString: url.href })
  await db.connect()
  const query = async (sql) => {
    const result = await db.query(sql)
    return Array.isArray(result) ? result.at(-1).rows : result.rows
  }
  try {
    assert.equal((await query("SELECT to_regnamespace('identity') AS existing"))[0].existing, null, 'use a fresh dedicated fixture')
    assert.deepEqual(await installFoundation(query), { installed: true, digest: foundationDigest })
    const versions = releases.map((release) => release.version)
    assert.deepEqual(await installReleases(query), { applied: versions, versions })
    assert.equal((await query('SHOW row_security'))[0].row_security, 'on', 'dump settings stay local to the installation transaction')
    const before = await query('SELECT version,digest,installed_at FROM gugu_install.releases')
    assert.deepEqual(await installFoundation(query), { installed: false, digest: foundationDigest })
    assert.deepEqual(await installReleases(query), { applied: [], versions })
    assert.deepEqual(await query('SELECT version,digest,installed_at FROM gugu_install.releases'), before)
    assert.equal((await query("SELECT count(*)::integer AS n FROM pg_policies WHERE schemaname='realtime' AND policyname LIKE 'gugu_%'"))[0].n, 8, 'foundation 7 + forum events')
    assert.equal((await query("SELECT count(*)::integer AS n FROM cron.job WHERE active AND jobname IN ('device-lease-sweep','file-blob-upload-sweep','file-blob-gc-kick')"))[0].n, 3)
    assert.equal((await query("SELECT to_regnamespace('billing') AS billing"))[0].billing, null)
    assert.equal((await query("SELECT count(*)::integer AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('model_access_reserve','cloud_computer_charge','gateway_pool_claim')"))[0].n, 0)

    await db.query('BEGIN')
    try {
      const [owner, member, outsider, chat, message] = Array.from({ length: 5 }, randomUUID)
      for (const id of [owner, member, outsider]) {
        await db.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
          VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`, [id, id + '@foundation.example.test'])
      }
      assert.equal((await db.query('SELECT count(*)::integer AS n FROM identity.users WHERE id=ANY($1)', [[owner, member, outsider]])).rows[0].n, 3, 'Auth trigger creates identities without commercial schemas')
      await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','installation fixture',$2)", [chat, owner])
      await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')", [chat, owner, member])
      await db.query('INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,$4)', [message, chat, owner, 'private fixture'])
      await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES ($1,$2,'fixture','fixture','linux')", ['foundation-' + owner, owner])
      await db.query('SET LOCAL ROLE authenticated')
      for (const [actor, visible] of [[owner, 1], [member, 1], [outsider, 0]]) {
        await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor])
        assert.equal((await db.query('SELECT count(*)::integer AS n FROM chat.messages WHERE id=$1', [message])).rows[0].n, visible)
        assert.equal((await db.query('SELECT count(*)::integer AS n FROM identity.gugu_devices WHERE user_id=$1', [owner])).rows[0].n, actor === owner ? 1 : 0)
      }
    } finally {
      await db.query('ROLLBACK')
    }
    await db.query('BEGIN')
    try {
      await db.query('CREATE FUNCTION public.foundation_acl_probe() RETURNS integer LANGUAGE sql AS $$SELECT 1$$')
      const privileges = (await db.query("SELECT has_function_privilege('anon','public.foundation_acl_probe()','EXECUTE') AS anon, has_function_privilege('authenticated','public.foundation_acl_probe()','EXECUTE') AS authenticated")).rows[0]
      assert.deepEqual(privileges, { anon: false, authenticated: false }, 'new functions require an explicit API grant')
      await db.query('GRANT EXECUTE ON FUNCTION public.foundation_acl_probe() TO authenticated')
      assert.equal((await db.query("SELECT has_function_privilege('authenticated','public.foundation_acl_probe()','EXECUTE') AS allowed")).rows[0].allowed, true)
    } finally { await db.query('ROLLBACK') }
    await db.query('BEGIN')
    try {
      await db.query("UPDATE gugu_install.releases SET digest='different' WHERE version='foundation-v1'")
      await assert.rejects(installFoundation(query), /explicit upgrade/)
    } finally { await db.query('ROLLBACK') }
    await db.query('BEGIN')
    try {
      await db.query("UPDATE gugu_install.releases SET digest='different' WHERE version=$1", [releases[0].version])
      await assert.rejects(installReleases(query), /publish changes as a new release file/)
    } finally { await db.query('ROLLBACK') }
    await db.query('BEGIN')
    try {
      await db.query("INSERT INTO gugu_install.releases(version,digest) VALUES ('29991231000000_unknown','x')")
      await assert.rejects(installReleases(query), /does not know/)
    } finally { await db.query('ROLLBACK') }
    await db.query('BEGIN')
    try {
      await db.query('CREATE SCHEMA billing')
      await assert.rejects(installFoundation(query), /not a standalone community/)
    } finally { await db.query('ROLLBACK') }
  } finally { await db.end() }
})
