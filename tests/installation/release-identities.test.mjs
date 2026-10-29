import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { installReleases, releases } from '../../scripts/foundation.mjs'

const migrations = new URL('../../supabase/migrations/', import.meta.url)
// These published identities and SQL digests predate the filename repairs.
const renamed = [
  ['20261027120001_message_agent_wakes_readable', '20261027120000_message_agent_wakes_readable', '655f5df062029090e8c3fad0c3ed81c02e8d86a97db88fd7f04809bda765e4d6'],
  ['20261028010001_file_storage_classes', '20261028010000_file_storage_classes', '867072c1d6e384c41c2fd92af9bc559c27f470091dd68c3b9dbe685411306604'],
  ['20261028070001_local_file_rename_carries_revision', '20261028070000_local_file_rename_carries_revision', 'a529f883667eb16dec5be194e48f3f988abcf96290e498289ba2bb42b8403f84'],
  ['20261029050001_offline_project_removal', '20261029050000_offline_project_removal', '8a82382cf032c2b149d843076823bf0efe0b775935b54328abe9eaf9f69334e2'],
]

test('all migration filenames have globally unique numeric prefixes', () => {
  const files = readdirSync(migrations).filter(file => file.endsWith('.sql'))
  const byPrefix = new Map()
  for (const file of files) {
    const match = /^(\d{14})_[a-z0-9_]+\.sql$/.exec(file)
    assert.ok(match, `Migration filename must have a 14-digit prefix: ${file}`)
    const prefix = match[1]
    assert.ok(!byPrefix.has(prefix), `Duplicate migration prefix: ${byPrefix.get(prefix)} and ${file}`)
    byPrefix.set(prefix, file)
  }
})

test('renumbered files preserve published release identities, SQL bytes and execution order', () => {
  for (const [file, identity, digest] of renamed) {
    const sql = readFileSync(new URL(file + '.sql', migrations), 'utf8')
    assert.equal(existsSync(new URL(identity + '.sql', migrations)), false)
    assert.equal(createHash('sha256').update(sql).digest('hex'), digest)
    const release = releases.find(release => release.version === identity)
    assert.ok(release, `Published ledger identity is missing: ${identity}`)
    assert.equal(release.sql, sql)
    assert.equal(release.digest, digest)
  }
  const versions = releases.map(release => release.version)
  assert.equal(new Set(versions).size, versions.length, 'community release identities stay unique')
  assert.deepEqual(versions, [...versions].sort(), 'published execution order stays stable')
  assert.ok(versions.indexOf('20261029050000_offline_project_removal') < versions.indexOf('20261029050000_task_agent_name_serial'))
})

test('the existing full-name ledger is accepted without writes or release replay', async () => {
  const oldIdentity = new Map(renamed.map(([file, identity]) => [file, identity]))
  const installed = releases.map(release => Object.freeze({
    version: oldIdentity.get(release.version) ?? release.version,
    digest: release.digest,
    installed_at: '2026-10-29T11:38:00.000Z',
  }))
  const before = structuredClone(installed)
  let reads = 0
  const result = await installReleases(async sql => {
    assert.match(sql, /^SELECT\b/i, 'an installed release must never execute again')
    assert.match(sql, /gugu_install\.releases/)
    reads++
    return installed
  })
  assert.ok(reads > 0, 'the existing ledger is actually read')
  assert.deepEqual(result, { applied: [], versions: releases.map(release => release.version) })
  assert.deepEqual(installed, before, 'version, digest and installed_at remain untouched')
})

test('a genuinely missing release still applies through the existing installer', async () => {
  const missing = releases.at(-1)
  assert.ok(missing)
  const writes = []
  const result = await installReleases(async sql => {
    if (sql.startsWith('SELECT version,digest')) return releases.filter(release => release !== missing)
    writes.push(sql)
    return []
  })
  assert.deepEqual(result.applied, [missing.version])
  assert.equal(writes.length, 1)
  assert.ok(writes[0].includes(missing.sql))
  assert.ok(writes[0].includes('INSERT INTO gugu_install.releases'))
  assert.ok(writes[0].includes(missing.version) && writes[0].includes(missing.digest))
})
