import assert from 'node:assert/strict'

export function assertCompleteProjectPublisherSource(sql) {
  for (const name of ['file_private.publish_revision_by', 'chat.file_device_publish', 'chat.file_version_handoff_publish']) {
    assert.match(sql, new RegExp('CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+' + name.replace('.', '\\.') + '\\s*\\(', 'i'))
  }
  assert.doesNotMatch(sql, /\bpg_get_functiondef\s*\(|^\s*EXECUTE\b/im, 'release must contain complete publisher definitions')
}

export async function assertAllocatedProjectPublisher(query) {
  const signature = 'file_private.publish_revision_by(uuid,text,text,text,text,bigint,text,text,integer,uuid,text)'
  const [publisher] = await query(`SELECT prosrc AS body,
    has_function_privilege('anon',oid,'EXECUTE') AS anon,
    has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated
    FROM pg_proc WHERE oid='${signature}'::regprocedure`)
  assert.match(publisher.body, /RETURNING\s+filename\s+INTO\s+p_filename/i, 'revision must retain the directory-allocated name')
  assert.equal(publisher.anon, false)
  assert.equal(publisher.authenticated, false, 'only existing definer entry points can reach the private publisher')
}
