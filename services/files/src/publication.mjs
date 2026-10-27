import * as Y from 'yjs'
import { applyJson, buildDoc, isJson, parseJsonObject, readFileText, readText, sameContent, spliceText } from '@gugu/files-core/content'
import { Denied } from './auth.mjs'

/** Use the original caller JWT for the existing transaction, never the file service's DB role. */
export async function publicationRpc(config, authorization, operation) {
  if (!config.supabaseUrl || !config.anonKey) throw new Denied('publication-not-configured', 503)
  const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${operation.fn}`, {
    method: 'POST', headers: { Authorization: authorization, apikey: config.anonKey, 'content-type': 'application/json', 'content-profile': 'chat', 'accept-profile': 'chat' },
    body: JSON.stringify(operation.args), signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json()
  if (!response.ok) throw Object.assign(new Denied(body.hint === 'workspace_version_conflict' ? 'version-conflict' : 'publication-rejected', body.hint === 'workspace_version_conflict' ? 409 : response.status), { detail: body })
  return body
}

/** Validate the existing transaction's target before draining any providers. No arbitrary RPC dispatch. */
export function publicationOperation(itemId, body, actorId) {
  const operation = body?.publication
  const args = operation?.args
  if (operation?.snapshot !== undefined && typeof operation.snapshot !== 'boolean') throw new Denied('bad-request', 400)
  const expected = operation?.fn === 'attachment_share' ? args?.p_version : args?.p_expected_version
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.p_staging_key !== 'string'
      || !Number.isSafeInteger(expected) || expected < 1) throw new Denied('bad-request', 400)
  if (operation.fn === 'attachment_commit' || operation.fn === 'attachment_share') {
    if (args.p_item_id !== itemId || args.p_sender_user_id !== actorId || args.p_is_whisper === true) throw new Denied('bad-request', 400)
  } else if (operation.fn === 'file_replace_as') {
    if (args.p_item_id !== itemId || args.p_as_user_id !== actorId) throw new Denied('bad-request', 400)
  } else throw new Denied('bad-request', 400)
  return operation
}

/** The common drain freezes a typed copy. Only a successful caller-JWT commit replaces the live generation. */
export async function publishDocument({ pool, files, document, name, itemId, identity, grant, operation, commit }) {
  const key = operation.args.p_staging_key
  const expected = operation.fn === 'attachment_share' ? operation.args.p_version : operation.args.p_expected_version
  const { rows } = await pool.query('SELECT chat.files_publication_input($1::uuid,$2,$3,$4,$5) AS input', [itemId, identity.userId, grant.actorId, key, expected])
  const input = rows[0].input
  if (input.committed) return await commit(operation)
  if (input.epoch !== grant.epoch) throw new Denied('version-conflict', 409)
  let result
  let replyError
  await files.swapGeneration(name, document, async (fresh) => {
    const baseline = buildDoc(grant.contentType, operation.snapshot ? input.document.text : input.text)
    let unchanged
    try { unchanged = sameContent(grant.contentType, readText(fresh, grant.contentType), readText(baseline, grant.contentType)) }
    finally { baseline.destroy() }
    if (!unchanged) throw new Denied('content-changed', 409)
    if (isJson(grant.contentType) !== isJson(input.document.content_type)) throw new Denied('content-type-changed', 409)
    if (!operation.snapshot) fresh.transact(() => {
      if (isJson(grant.contentType)) applyJson(fresh.getMap('root'), parseJsonObject(input.document.text))
      else spliceText(fresh.getText('content'), input.document.text)
    })
    const text = readText(fresh, grant.contentType)
    const recorded = buildDoc(grant.contentType, input.text)
    let sameBody
    try { sameBody = sameContent(grant.contentType, text, readText(recorded, grant.contentType)) }
    finally { recorded.destroy() }
    await pool.query('SELECT chat.files_prepare_publication($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [itemId, identity.userId, grant.actorId, key, expected, grant.epoch, text, Buffer.from(Y.encodeStateAsUpdate(fresh)), readFileText(fresh, grant.contentType), sameBody])
    try { result = await commit(operation) }
    catch (error) {
      const resolved = await pool.query('SELECT chat.files_abort_publication($1::uuid,$2,$3,$4,$5) AS epoch',
        [itemId, identity.userId, grant.actorId, key, grant.epoch])
      if (resolved.rows[0].epoch === null) throw error
      // The transaction committed but its HTTP reply was lost. Retire this generation, then fail
      // the request so the caller can replay the original idempotent transaction and read its result.
      replyError = error
    }
    return grant.epoch + 1
  })
  if (replyError) throw replyError
  return result
}
