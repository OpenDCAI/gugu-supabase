# Existing test protections during the file-transfer change

The following 24 unit cases initially failed because their RPC fixtures described the previous entry points. Each row records the original protection and its current assertion. Existing content hashes, ETags, actor arguments, failure codes, copy retries and GC claim tokens remain asserted. The fake records control RPCs separately **and** records a combined RPC/object-operation order; the separation does not hide the new authorization boundary.

`expectManagedCommit` asserts the exact authorization/inspection prefix, registration before publication, retained staging, no early DELETE and no reservation-close call. Five additional denial cases prove that a rejected upload, commit, placement, private attachment or download reaches neither object storage nor publication.

| Case | Original protection | Protection after migration; intentional changes |
| --- | --- | --- |
| Storage configuration: existing OSS read | Existing OSS records use CDN, never Supabase signing | Same CDN origin/thumbnail assertions; authorized download descriptor and deployment throttle/TTL fixture replace the old metadata-only RPC stub. |
| Raw representation: 17 bytes | Original SHA and ETag survive inspection | Same SHA, size and source if-match; also checks authorization before GET and retained staging. |
| Raw representation: 1023 bytes | Original SHA and ETag survive inspection | Same SHA, size and source if-match; also checks authorization before GET and retained staging. |
| Raw representation: 1024 bytes | Compression threshold must not lose the original ETag | Same SHA, size and source if-match across the compression boundary; also checks authorization order. |
| Raw representation: 30720 bytes | Hash original bytes, not a compressed representation | Same exact digest, size and ETag; also checks authorization order. |
| Raw representation: 153600 bytes | Hash original bytes, not a compressed representation | Same exact digest, size and ETag; also checks authorization order. |
| Raw representation: 5242880 bytes | Larger original representation still locks the copy source | Same exact digest, size and ETag; also checks authorization order. |
| PNG commit | Inspect, copy with true MIME, register, publish as caller; preserve caption behavior | Same exact object headers, byte metadata, publication arguments and RPC order. **Old:** DELETE staging before publication. **New:** retain immutable staging and its held quota. **Why:** deleting while a signed upload remains usable permits recreation. |
| Declared MIME mismatch | A false image declaration cannot turn arbitrary bytes into an image | Same registered MIME and attachment disposition; authorization/order/retention assertions added. |
| Blob being collected | Re-copy/re-register; stop after five failures without publication | Same exact three-copy success and five-failure refusal; success also checks managed boundary. |
| ETag changes after read | Changed source cannot create a SHA-named object or message | Same 409 `upload_changed`, zero final objects and no registration/publication. |
| Collection between copy and register | Missing final bytes must be re-copied; an existing blob does not require the extra HEAD | Same GET/PUT/HEAD/PUT versus GET/PUT sequences and final exact bytes. **Old:** staging becomes absent. **New:** original staging bytes remain. **Why:** upload-policy replay protection and capacity accounting. |
| Missing/oversized/foreign staging | Missing staged bytes use the existing receipt; oversized or foreign bytes cannot register | Same receipt-only retry, 413 above the permit fixture and rejection before I/O for another uploader. The fixture's 25 MiB is a permit value, not the deployment's fixed ceiling. |
| Send as owner to a friend | Preserve delegated actor, friend, request ID and caption; missing request ID causes no byte read | All original arguments and no-I/O rejection retained; managed scope and registration ordering added. |
| Place a file | Preserve folder, actor and source messages; do not send a chat message | Exact original placement/publication arguments retained; managed scope precedes bytes. |
| Replace a file | Preserve item ID, expected version and root/default actor behavior | Exact replacement/default assertions retained; managed scope precedes bytes. |
| Invalid placement input | Foreign staging, invalid version and missing name reject before object I/O | Original refusal and empty object-call assertions retained. |
| Physical prefix isolation | Upload, copy, signing and GC remain within the configured physical prefix; database keys stay logical | All original prefix/copy-source/signature/purge-path assertions retained. **Old:** commit immediately deleted staging. **New:** commit retains it; **Why:** replay-safe staging and one cleanup entry point. |
| Upload staging key | Random staging key belongs to the authenticated uploader | Same exact key and form assertions; explicit declared size now obtains a quota-bound upload permit first. |
| URL mapping | Fixed revision/message references, actor ACL, CDN versus historical storage and thumbnails | Same per-reference identities, URL origins, thumbnail rules and invalid-input refusals. **Old:** metadata-only `file_urls_as`, 1800-second links. **New:** quota-authorized downloads, 60-second links. **Why:** ACL plus reservation must precede every signature; edge expiry has a separate test. |
| Object GC | Remove OSS bytes, invalidate thumbnails, preserve legacy deletion and lease tokens; isolate failures | Exact original object operations, successful tokens and failed-token/error assertions retained.  |
| Legacy forwarding | Read only the authorized legacy source, stage original bytes and reuse the same registration/publication pipeline | Original source, size, MIME, staged key and forward arguments retained. **Old:** directly sign source and delete new staging after registration. **New:** reserve source download before signing and retain destination staging. **Why:** no download-budget bypass or replay-created uncharged object. |
| Private attachment commit | Preserve exact original bytes and SHA; never create a chat message | Exact bytes/SHA/no-chat-publication assertions retained; common managed scope and publication order added. |
| Private attachment signatures | Only database-authorized references for the selected Agent receive a URL | Same actor, reference identity, SHA/size and empty unauthorized result; authorization now uses the common quota-aware download RPC. |

## Additional integration behavior changes

| Test | Old expectation | New expectation and retained protection | Reason |
| --- | --- | --- | --- |
| `fileBlobs.test.ts`: internal registration size | Internal registration rejects 25 MiB + 1 | Internal service registration supports larger files; `fileTransferBudget.test.ts` rejects a public upload above its configured ceiling. Invalid hash, empty bytes, foreign staging, changed replay identity and authenticated-role denial remain exact assertions. | The deployment-configured public upload permit owns the size ceiling. |
| `topicSourceResources.test.ts`: historical Storage access | Source members directly SELECT/INSERT/DELETE workspace objects through topic keys | The same source member resolves/signs the exact old pointer and obtains a scoped managed upload; the outsider cannot. The reservation/upload records contain the source group. Direct Storage reads/writes/deletes are denied, including to members. | All bytes use the managed provider; topic scope must not bypass quotas. |
| `workspaceFileVersions.test.ts`: physical deletion | A member deletes unused bytes directly; an uploader can delete their own bytes | Original reference/membership predicate assertions remain as isolated predicate checks. Actual authenticated physical reads/deletes return no rows for owner/member/outsider; the member still reads through the workspace API, while the outsider is denied. | Physical deletion belongs to service cleanup and must not release capacity or race active readers through a direct client path. |


Deployment-wide quota fixtures run before concurrent object-writing suites. Their global cap includes pre-existing physical occupancy plus the exact original tested headroom: 80 or 1000 bytes. All success/refusal assertions remain, including rejection of the next 1 byte and the exact 120-byte usage increase. This preserves the boundary on repeat runs without deleting other fixtures or pretending their objects do not consume storage.
