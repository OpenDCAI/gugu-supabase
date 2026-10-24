import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { foundationDigest, installFoundation, installReleases, releases } from '../../scripts/foundation.mjs'
import { topicResourcesFixture } from './topic-resources-fixture.mjs'
import { installTopicResourcesConcurrently } from './topic-resource-concurrency.mjs'

// Deliberately requires an empty, disposable Supabase PostgreSQL 17 instance.
// Never resets schemas, migration history, or user data to make a test pass.
test('fresh foundation, repeat installation, authorization and refusal guards', async (t) => {
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
    const userEventsRelease = releases.find((release) => release.version.endsWith('_human_user_events'))
    assert.ok(userEventsRelease, 'human user-events is an incremental release')
    const topicRelease = releases.find((release) => release.version.endsWith('_topic_source_resources'))
    assert.ok(topicRelease)
    const idleExpiryRelease = releases.find((release) => release.version.endsWith('_large_file_idle_expiry'))
    assert.ok(idleExpiryRelease)
    const releaseQuery = async (sql) => {
      if (sql.includes(idleExpiryRelease.sql)) {
        const owner=randomUUID(),group=randomUUID(),blob=randomUUID(),stored=randomUUID(),sha='ef'.repeat(32)
        await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','retention upgrade fixture')",[owner])
        await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','retention upgrade',$2)",[group,owner])
        await db.query("INSERT INTO chat.file_blobs(id,bucket_id,object_name,sha256,size_bytes,content_type,created_by) VALUES($1,'oss',$2,$3,51,'application/octet-stream',$4)",[blob,'ef/'+sha,sha,owner])
        await db.query("INSERT INTO chat.file_transfer_storage(id,blob_id,bucket_id,object_name,size_bytes) VALUES($1,$2,'oss',$3,51)",[stored,blob,'ef/'+sha])
        await db.query("INSERT INTO chat.file_transfer_storage_refs(storage_id,chat_id,account_id,created_at) VALUES($1,$2,$3,now()-interval '2 years')",[stored,group,owner])
        const original=(await db.query('SELECT created_at FROM chat.file_transfer_storage_refs WHERE storage_id=$1',[stored])).rows[0].created_at
        await t.test('idle expiry upgrade rolls back all columns and preserves legacy references',async()=>{
          await query(sql.replace(/COMMIT;\s*$/, 'ROLLBACK;'))
          assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='chat' AND table_name='file_transfer_storage_refs' AND column_name='retention_started_at'")).rows[0].n,0)
          assert.deepEqual((await db.query('SELECT created_at FROM chat.file_transfer_storage_refs WHERE storage_id=$1',[stored])).rows[0].created_at,original)
        })
        const result=await query(sql)
        await t.test('idle expiry upgrade gives old references a full interval without inventing downloads',async()=>{
          const r=(await db.query("SELECT *,retention_started_at>now()-interval '1 minute' AS fresh FROM chat.file_transfer_storage_refs WHERE storage_id=$1",[stored])).rows[0]
          assert.deepEqual(r.created_at,original);assert.equal(r.last_download_at,null);assert.equal(r.expired_at,null);assert.equal(r.fresh,true)
        })
        await db.query('DELETE FROM chat.file_transfer_storage WHERE id=$1',[stored])
        await db.query('DELETE FROM chat.file_blobs WHERE id=$1',[blob])
        await db.query('DELETE FROM chat.chats WHERE id=$1',[group])
        await db.query('DELETE FROM identity.users WHERE id=$1',[owner])
        return result
      }
      if (sql.includes(topicRelease.sql)) {
        const rolledBack = sql.replace(/COMMIT;\s*$/, 'ROLLBACK;')
        await t.test('topic resources install on an empty community database', async () => {
          await query(rolledBack)
        })
        await t.test('a legacy non-UUID chat aborts and rolls back the complete upgrade', async () => {
          const owner = randomUUID(), id = '123456789'
          await db.query('BEGIN')
          await db.query("INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human','legacy id fixture')", [owner])
          await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','legacy id',$2)", [id, owner])
          await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner')", [id, owner])
          await db.query('COMMIT')
          try {
            await assert.rejects(query(sql), { code: '23514', constraint: 'chats_id_uuid' })
            await db.query('ROLLBACK')
            assert.equal((await query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='chat.chats'::regclass AND conname='chats_id_uuid'"))[0].n, 0)
            assert.equal((await db.query('SELECT id FROM chat.chats WHERE id=$1', [id])).rows[0].id, id)
            assert.equal((await query("SELECT prorettype::regtype::text AS type FROM pg_proc WHERE oid='chat.workspace_require_room_member(text,text)'::regprocedure"))[0].type, 'void')
          } finally {
            await db.query('ROLLBACK')
            await db.query('DELETE FROM chat.chats WHERE id=$1', [id])
            await db.query('DELETE FROM identity.users WHERE id=$1', [owner])
          }
        })
        const fixture = await topicResourcesFixture(db)
        await t.test('topic metadata upgrade rolls back without changing rows, functions or guards', async () => {
          const started = performance.now()
          await query(rolledBack)
          console.log('topic upgrade quiet metadata transaction ms:', performance.now() - started)
          assert.deepEqual(await fixture.snapshot(), fixture.before)
          assert.equal((await query("SELECT prorettype::regtype::text AS type FROM pg_proc WHERE oid='chat.workspace_require_room_member(text,text)'::regprocedure"))[0].type, 'void')
        })
        await t.test('an unexpected referenced system folder aborts the whole release', async () => {
          await fixture.poison()
          const poisoned = await fixture.snapshot()
          await assert.rejects(query(sql), /system folder has content or references/)
          await query('ROLLBACK')
          assert.deepEqual(await fixture.snapshot(), poisoned)
          assert.equal((await query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='chat.workspace_items'::regclass AND tgname IN ('workspace_items_place','workspace_items_guard_delete') AND tgenabled='O'"))[0].n, 2)
          await fixture.unpoison()
        })
        const result = await installTopicResourcesConcurrently(db, sql, (name, run) => t.test(name, run))
        await t.test('topic upgrade preserves IDs, boards, versions, bytes and upload retries', () => fixture.assertMigrated())
        await fixture.cleanup()
        return result
      }
      if (!sql.includes(userEventsRelease.sql)) return query(sql)
      // First exercise the release on the clean community schema and roll it
      // back. Then install it with an independent producer present. Both paths
      // must work without the release owning or changing that extension.
      await t.test('human user-events release installs on the community schema', async () => {
        assert.match(sql, /COMMIT;\s*$/)
        await query(sql.replace(/COMMIT;\s*$/, 'ROLLBACK;'))
        assert.equal((await query("SELECT to_regprocedure('chat.send_user_event(jsonb,text,text,boolean)') AS helper"))[0].helper, null)
      })
      let result
      await t.test('human user-events release preserves an independent user-event sender', async () => {
        await query(`CREATE SCHEMA user_events_extension;
        CREATE FUNCTION user_events_extension.emit(p_user_id text) RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $extension$
        BEGIN
          PERFORM realtime.send('{}'::jsonb,'extension_changed','gugu:user:'||p_user_id||':events',true);
        END $extension$;
        REVOKE ALL ON FUNCTION user_events_extension.emit(text) FROM PUBLIC,anon,authenticated;
        GRANT EXECUTE ON FUNCTION user_events_extension.emit(text) TO service_role;`)
        const extension = () => query(`SELECT pg_get_functiondef(oid) AS definition,proacl::text AS acl
          FROM pg_proc WHERE oid='user_events_extension.emit(text)'::regprocedure`)
        const before = await extension()
        result = await query(sql)
        assert.deepEqual(await extension(), before, 'release preserves independent producers and their ACL')
        await query('DROP SCHEMA user_events_extension CASCADE')
      })
      return result
    }
    assert.deepEqual(await installReleases(releaseQuery), { applied: versions, versions })
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
    await t.test('project metadata tables are closed and only intended read/publish APIs are granted', async () => {
      for (const table of ['file_project_policies','file_device_revisions']) {
        assert.equal((await query(`SELECT relrowsecurity AS enabled FROM pg_class WHERE oid='chat.${table}'::regclass`))[0].enabled, true)
        for (const role of ['anon','authenticated']) {
          for (const privilege of ['SELECT','INSERT','UPDATE','DELETE']) {
            assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed', [role,'chat.'+table,privilege])).rows[0].allowed, false)
          }
        }
      }
      for (const signature of ['file_project_policy_as(text,text,text,boolean,boolean,text)','file_project_policy_for(text,text)',
        'file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid)','file_resolve_as(jsonb,text)']) {
        assert.equal((await db.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS allowed", ['chat.'+signature])).rows[0].allowed, true)
        assert.equal((await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') AS allowed", ['chat.'+signature])).rows[0].allowed, false)
      }
    })
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
