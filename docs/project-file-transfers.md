# Project files: local metadata and encrypted on-demand transfer

Implementation is being developed in separate commits. This first group adds metadata and authorization only; it does not yet activate temporary transfer or replace client reads.

| Runtime group | Approved behavior | Added / removed lines |
| --- | --- | --- |
| Policy, local revisions, metadata resolver and write guard | Project files default to local storage; a bound host publishes immutable versions; remote access is read-only | 179 / 0 |

`file_project_policy_as` requires the actual project binding, device ownership and group administrator membership. Proactive upload defaults to false; temporary transfer and its retention are separate explicit settings. An unbound or removed project cannot resolve a local revision even if an obsolete policy survives. Absolute roots are not included in the file resolver response.

`file_device_publish` records a device, project, canonical relative path, SHA-256, size, name and content type for each immutable file version. Negative sizes, traversal, absolute paths, Windows drive/UNC paths, control characters and ambiguous separators are refused atomically. Existing documents and files belonging to another group cannot be overwritten. A version conflict cannot silently replace metadata. The host must still perform its existing realpath/root fence and verify SHA before serving bytes: metadata alone is not filesystem authorization.

`file_resolve_as` is the common metadata entry point for local files, managed objects, pinned message versions and private task attachments. It delegates actor, membership, message visibility and managed-object permissions to the existing helpers. It returns no signing URL, data key, arbitrary-path read or device write capability. Managed references retain their expired status. Message pinning accepts local metadata through the original attachment trigger without inventing a cloud blob.

Existing mutation APIs cannot modify a local reference on behalf of another reader. Even the owner cannot create an unindexed file version through a cloud rename/replace: local changes must first be published by the host. Existing cloud files retain their existing mutation permissions. A metadata deletion does not delete a host filesystem path.

All new tables have RLS and no direct API grants. Only intended metadata/publish functions are authenticated; internal trigger/envelope functions remain closed. Tests cover these grants both on installation and at the service contract boundary.

The next groups add temporary generations using the existing quota reservations and signer, service-only key columns, and the original blob garbage collector. Permanent files must never enter temporary-transfer LRU. No second worker, signing protocol or restore RPC is introduced.

The client implementation will have one resolver before any cloud metadata lookup: local loopback, the reader's already-open owner SSH link, then encrypted temporary cloud transfer. Expired cards and ordinary re-upload belong to the separate permanent-file expiry change, not this resolver change.
