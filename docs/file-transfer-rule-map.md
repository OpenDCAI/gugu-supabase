# Budget-floor rule and change map

Refs #32. This change implements only the shared budget floor. Rule 1 is the global monthly download budget; rule 2 is short signatures plus request limits; rule 3 is global storage admission; rule 4 is account/group isolation. Idle expiry, local resolution, temporary transfers, LRU and media-object migration are separate changes.

Runtime/config against the parent: **+881 / -122 = +759 lines**. Tests and their runner: **+585 / -37 = +548 lines**. Documentation is counted separately. No extra signing algorithm, quota classifier, restore RPC, wrapping keyring, expiry worker or second final-object GC is added.

## Incremental SQL release: 531 added lines

The following disjoint spans cover the complete new release, including comments, grants and blank lines. They are not additional copies of the runtime total.

| Block | Lines | Approved rule |
| --- | ---: | --- |
| Quota, physical objects, references, reservations, observations and service-only access | 60 | 1, 3, 4 |
| Human/source-group attribution and deployment settings | 37 | 1, 3, 4 |
| Shared usage arithmetic and atomic admission | 94 | 1, 3, 4 |
| Immutable observed traffic and conservative settlement | 34 | 1 |
| Existing blob/reference adoption | 27 | 3, 4 |
| Provider-bound upload admission, scope, single registration and terminal staging evidence | 120 | 3, 4 |
| Publication/forwarding reference guards, restricted legacy workspace access and existing-GC bookkeeping | 65 | 3, 4 |
| Existing exact-reference ACL plus download reservation | 48 | 1, 2, 4 |
| Atomic trusted usage import | 25 | 1, 4 |
| Trusted physical inventory, including unreferenced objects | 21 | 3 |

## Other runtime/config changes

| File/block | Added / removed | Approved rule |
| --- | ---: | --- |
| Ignore local secrets directory | 1 / 0 | Deployment hygiene |
| Official log/inventory normalization and protected JSONL importer | 79 / 0 | 1, 3, 4 |
| Existing object-provider upload bounds, inspection and signing capabilities | 49 / 9 | 2, 3 |
| Existing storage configuration: edge TTL and fixed rate declaration | 9 / 1 | 2 |
| Existing attachments core: common managed upload/download, forwarding and cleanup entry points; remove unused old URL descriptor | 81 / 94 | 1–4 |
| Bounded streamed SHA-256 inspection using built-in crypto | 26 / 0 | 3 |
| Common exact-reference download and service import validation | 65 / 0 | 1–4 |
| Existing object-provider interface | 6 / 2 | 2, 3 |
| Existing CDN Type A signer, actual edge-expiry equation | 13 / 4 | 2 |
| Existing HTTP entry: service-only import and strict native Storage gateway declaration | 21 / 12 | 1–4 |

## Verification and intentional behavior changes

`fileTransferConcurrency.test.ts` uses eight independent PostgreSQL connections held at the same advisory-lock boundary. Exactly three contenders win the final three bytes for global/account/group downloads and storage; eight identical retries reserve one byte. This is actual concurrent admission, not a serial fake.

All original tests remain in the runner. Policy fixtures run serially before concurrent object-writing suites; the remaining integration files retain their normal parallel execution. [The migration audit](file-transfer-test-migration.md) maps every changed original protection and explicitly records old/new expectations: retained staging, quota-aware 60-second downloads, configured public upload size, and managed legacy workspace access. Hashes, ETags, actor ACLs, source/group identity, GC tokens and failure boundaries remain asserted.

Provider-log and CLI tests prove normalization, credential omission, immutable identities, exact-object attribution and batch atomicity. They do not prove that an external logging export is complete. A missing provider request limit or unreadable versioning metadata refuses issuance; an environment declaration alone is not cloud configuration. Real-provider and real-client validation must be reported independently from isolated contracts.
