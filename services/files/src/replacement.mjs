import * as Y from 'yjs'
import { applyJson, buildDoc, isJson, parseJsonObject, readText, sameContent, spliceText } from '@gugu/files-core/content'
import { Denied } from './auth.mjs'

// Only incoming bytes: the Edge keeps the caller-JWT message transaction. F71 owns drain/resume/reopen.
export async function replaceIncoming({ pool, files, hp, open, itemId, identity, grant, body }) {
  const { key, expected, finish } = body
  if (typeof key !== 'string' || !Number.isSafeInteger(expected) || expected < 1 || typeof finish !== 'boolean') throw new Denied('bad-request', 400)
  const stage = async (prepared = null, close = false) => {
    const { rows } = await pool.query('SELECT chat.files_replace_stage($1::uuid,$2,$3,$4,$5,$6::jsonb,$7) AS data',
      [itemId, identity.userId, grant.actorId, key, expected, prepared, close]).catch(error => {
        if (error.hint === 'workspace_version_conflict') throw new Denied('version-conflict', 409)
        throw error
      })
    return rows[0].data
  }
  const prior = [...files.docs.values()].find(info => info.itemId === itemId && info.replacement?.key === key)?.replacement
  if (finish) {
    if (prior && (prior.user !== identity.userId || prior.actor !== grant.actorId)) throw new Denied('not-found')
    if (prior) await prior.finish()
    else await stage(null, true)
    return { ok: true }
  }
  const input = await stage()
  if (input.committed) return { ok: true }
  const { dc, grant: current } = await open()
  const name = `${itemId}@${current.epoch}`, document = hp.documents.get(name), info = files.docs.get(name)
  if (!info || !document || info.replacement || info.hot || files.frozen(name)) { await dc.disconnect(); throw new Denied('compacting', 409) }
  let ready, failed, complete, timer, closing
  const prepared = new Promise((resolve, reject) => { ready = resolve; failed = reject })
  const committed = new Promise(resolve => { complete = resolve })
  const job = info.replacement = { key, user: identity.userId, actor: grant.actorId, finish: async () => {
    if (closing) return closing
    closing = stage(null, true).then(result => { complete(result.epoch); return job.done })
      .catch(error => { closing = null; throw error })
    return closing
  } }
  job.done = files.swapGeneration(name, document, async fresh => {
    const baseline = buildDoc(grant.contentType, input.text)
    try { if (!sameContent(grant.contentType, readText(fresh, grant.contentType), readText(baseline, grant.contentType))) throw new Denied('content-changed', 409) }
    finally { baseline.destroy() }
    if (isJson(grant.contentType) !== isJson(input.document.content_type)) throw new Denied('content-type-changed', 409)
    fresh.transact(() => {
      if (isJson(grant.contentType)) applyJson(fresh.getMap('root'), parseJsonObject(input.document.text))
      else spliceText(fresh.getText('content'), input.document.text)
    })
    await stage({ epoch: current.epoch, text: readText(fresh, grant.contentType), state: Buffer.from(Y.encodeStateAsUpdate(fresh)).toString('hex') })
    // The DB capability expires after 30 seconds. Even if cancellation cannot reach the DB,
    // release after that deadline: the original transaction can no longer consume this preparation.
    timer = setTimeout(() => { void job.finish().catch(() => complete(null)) }, 31_000)
    ready({ ok: true })
    const epoch = await committed
    if (epoch === null) throw new Denied('replacement-aborted', 409)
    return epoch
  }).catch(error => { failed(error); throw error }).finally(async () => {
    clearTimeout(timer)
    delete info.replacement
    await dc.disconnect()
  })
  // Drain failure is delivered through prepared; keep the completion rejection observed as well.
  void job.done.catch(() => {})
  return await prepared
}
