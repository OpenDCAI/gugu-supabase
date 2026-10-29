import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const foundationFile = fileURLToPath(new URL('../supabase/migrations/20261021000000_foundation.sql', import.meta.url))
export const foundationSql = readFileSync(foundationFile, 'utf8')
export const foundationDigest = createHash('sha256').update(foundationSql).digest('hex')

const migrationsDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url))
// Numeric filenames are unique for Supabase CLI. Published community ledger IDs
// remain immutable when a colliding filename is renumbered; SQL bytes stay intact.
const releaseIdentityByFile = {
  '20261027120001_message_agent_wakes_readable.sql': '20261027120000_message_agent_wakes_readable',
  '20261028010001_file_storage_classes.sql': '20261028010000_file_storage_classes',
  '20261028070001_local_file_rename_carries_revision.sql': '20261028070000_local_file_rename_carries_revision',
  '20261029050001_offline_project_removal.sql': '20261029050000_offline_project_removal',
}
/** Releases retain their published identity, digest and order independently of filename repairs. */
export const releases = readdirSync(migrationsDir)
  .filter((file) => /^\d{14}_[a-z0-9_]+\.sql$/.test(file) && file !== '20261021000000_foundation.sql')
  .map((file) => {
    const sql = readFileSync(migrationsDir + file, 'utf8')
    return { version: releaseIdentityByFile[file] ?? file.slice(0, -4), sql, digest: createHash('sha256').update(sql).digest('hex') }
  })
  .sort((a, b) => a.version < b.version ? -1 : a.version > b.version ? 1 : 0)

/** query runs a complete SQL request on one connection. No historical ledger is rewritten. */
export async function installFoundation(query) {
  const [state] = await query(`SELECT current_setting('server_version_num')::integer AS version,
    to_regnamespace('identity') IS NOT NULL AS has_identity,
    to_regnamespace('billing') IS NOT NULL AS has_billing,
    to_regclass('gugu_install.releases') IS NOT NULL AS has_ledger,
    to_regclass('auth.users') IS NOT NULL AND to_regclass('storage.objects') IS NOT NULL
      AND to_regclass('realtime.messages') IS NOT NULL AS has_platform`, true)
  if (!state || Number(state.version) < 170000) throw new Error('Gugu foundation requires PostgreSQL 17 or newer')
  if (!state.has_platform) throw new Error('Initialize Supabase Auth, Storage and Realtime before installing the foundation')
  if (state.has_ledger) {
    const rows = await query("SELECT digest FROM gugu_install.releases WHERE version='foundation-v1'", true)
    if (rows.length !== 1 || rows[0].digest !== foundationDigest) throw new Error('Installed foundation differs; use an explicit upgrade, never reset its ledger')
    if (!state.has_identity || state.has_billing) throw new Error('This is not a standalone community foundation')
    return { installed: false, digest: foundationDigest }
  }
  if (state.has_identity || state.has_billing) throw new Error('Use a new dedicated project; this database already contains Gugu or official service schemas')
  await query(`BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('gugu:foundation-install:v1',0));
DO $fresh$ BEGIN
  IF to_regnamespace('identity') IS NOT NULL OR to_regnamespace('billing') IS NOT NULL OR to_regnamespace('chat') IS NOT NULL OR to_regnamespace('gugu_install') IS NOT NULL THEN
    RAISE EXCEPTION 'Foundation requires a fresh dedicated project';
  END IF;
END $fresh$;
${foundationSql}
CREATE SCHEMA gugu_install;
REVOKE ALL ON SCHEMA gugu_install FROM PUBLIC,anon,authenticated;
CREATE TABLE gugu_install.releases(version text PRIMARY KEY,digest text NOT NULL,installed_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON gugu_install.releases FROM PUBLIC,anon,authenticated;
INSERT INTO gugu_install.releases(version,digest) VALUES('foundation-v1','${foundationDigest}');
COMMIT;`)
  const [result] = await query("SELECT digest FROM gugu_install.releases WHERE version='foundation-v1'", true)
  if (result?.digest !== foundationDigest) throw new Error('Foundation installation could not be verified')
  return { installed: true, digest: foundationDigest }
}

/** Applies every release not yet in the ledger, each in its own transaction. Recorded releases must match their source. */
export async function installReleases(query) {
  const rows = await query("SELECT version,digest FROM gugu_install.releases WHERE version<>'foundation-v1'", true)
  const installed = new Map(rows.map((row) => [row.version, row.digest]))
  for (const version of installed.keys()) {
    if (!releases.some((release) => release.version === version)) throw new Error('Database has release ' + version + ' that this source does not know; use a matching or newer source')
  }
  const applied = []
  for (const release of releases) {
    if (installed.has(release.version)) {
      if (installed.get(release.version) !== release.digest) throw new Error('Installed release ' + release.version + ' differs from source; publish changes as a new release file')
      continue
    }
    await query(`BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('gugu:foundation-install:v1',0));
DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM gugu_install.releases WHERE version='${release.version}') THEN
    RAISE EXCEPTION 'Release ${release.version} was installed concurrently';
  END IF;
END $guard$;
${release.sql}
INSERT INTO gugu_install.releases(version,digest) VALUES('${release.version}','${release.digest}');
COMMIT;`)
    applied.push(release.version)
  }
  return { applied, versions: releases.map((release) => release.version) }
}
