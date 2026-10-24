# Project files: local metadata and encrypted on-demand transfer

Implementation is being developed in separate commits. This first group adds metadata and authorization only; it does not yet activate temporary transfer or replace client reads.

| Runtime group | Approved behavior | Added / removed lines |
| --- | --- | --- |
| Policy, local revisions, metadata resolver and write guard | Project files default to local storage; a bound host publishes immutable versions; remote access is read-only | 179 / 0 |
| Temporary requests, scoped host accept/commit, original download issuance and private key return | Upload only for a real authorized read; ciphertext stays on a private origin; shared storage/download budgets apply before permits | 324 / 8 |

`file_project_policy_as` requires the actual project binding, device ownership and group administrator membership. Proactive upload defaults to false; temporary transfer and its retention are separate explicit settings. An unbound or removed project cannot resolve a local revision even if an obsolete policy survives. Absolute roots are not included in the file resolver response.

`file_device_publish` records a device, project, canonical relative path, SHA-256, size, name and content type for each immutable file version. Negative sizes, traversal, absolute paths, Windows drive/UNC paths, control characters and ambiguous separators are refused atomically. Existing documents and files belonging to another group cannot be overwritten. A version conflict cannot silently replace metadata. The host must still perform its existing realpath/root fence and verify SHA before serving bytes: metadata alone is not filesystem authorization.

`file_resolve_as` is the common metadata entry point for local files, managed objects, pinned message versions and private task attachments. It delegates actor, membership, message visibility and managed-object permissions to the existing helpers. It returns no signing URL, data key, arbitrary-path read or device write capability. Managed references retain their expired status. Message pinning accepts local metadata through the original attachment trigger without inventing a cloud blob.

Existing mutation APIs cannot modify a local reference on behalf of another reader. Even the owner cannot create an unindexed file version through a cloud rename/replace: local changes must first be published by the host. Existing cloud files retain their existing mutation permissions. A metadata deletion does not delete a host filesystem path.

All new tables have RLS and no direct API grants. Only intended metadata/publish functions are authenticated; internal trigger/envelope functions remain closed. Tests cover these grants both on installation and at the service contract boundary.

Temporary generations use the existing quota reservations and immutable provider forms. Their random `temporary/<group>/<file>/<version>/<SHA>/<generation>` objects are registered in the original blob inventory with logical bucket `temporary`; they share the configured physical object provider. Commit verifies ciphertext size and SHA by streaming before storing the service-only file key. Database and object-storage backups together can decrypt these files; this protects against storage disclosure, not the service operator.

The same `file_transfer_download_as` transaction authorizes metadata and reserves actual ciphertext bytes. Its private context binds the original reference, actor and generation. Key return is service-only, bound to the same authenticated account and unexpired reservation, and rechecks the exact reference and current policy. A read completion affects retention only; it does not refund download allowance. Retained generations renew only on a fresh authorized download, with a 30-day absolute ceiling. Read-once generations bind one download identity.

Encrypted temporary reads bypass CDN. `ali-oss@6.23.0` (MIT) supplies its official `signatureUrlV4`; no new signature algorithm is implemented. The SDK signs its current time, so retries use the reservation's remaining lifetime and reject any actual signature deadline beyond that reservation. The origin signature includes the request throttle and download attribution identifier. The SDK is an edge-function dependency and does not enter the client installation package. The Deno lock pins its transitive dependencies.

If provider capabilities cannot be verified, acceptance fails closed and does not expose an upload form. A previously reserved allowance remains held until trusted terminal evidence permits closure. An expired permit plus HEAD 404 still does not prove that a previously accepted upload cannot finish late. Temporary uploads write their final random position directly: operators must not apply ordinary staging-prefix cleanup to active generations. Physical cleanup belongs to the original blob collector; an unverified abandoned upload must not receive an automatic financial refund.

The final backend group connects expiry, revocation and temporary-only LRU to the original blob garbage collector. Permanent files must never enter that LRU. No second worker, quota ledger or restore RPC is introduced.

The client implementation will have one resolver before any cloud metadata lookup: local loopback, the reader's already-open owner SSH link, then encrypted temporary cloud transfer. Expired cards and ordinary re-upload belong to the separate permanent-file expiry change, not this resolver change.
