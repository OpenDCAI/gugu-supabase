# Idle expiry of large non-project files

Status display uses the read-only `file_resolve_as` entry point (`attachments/file-resolve`). It reuses the original actor, message and file ACL and returns `ready`, `expired` or `gone`. It never signs a URL, reserves a download, changes `last_download_at`, or refreshes retention. Signing belongs to an actual byte request. Project-file resolution extends this same entry point instead of adding another resolver.

This release follows the transfer budget boundary and reuses its storage inventory, reference attribution and atomic quota lock. It does not implement project-local resolution, temporary transfers, public-media migration or client UI. Permanent files are never quota or LRU eviction candidates.

## Deployment policy

Add `large_file_bytes`, `large_file_idle_seconds` and `storage_warning_percent` to the existing global `chat.file_transfer_limits.settings` object. File size must be **strictly greater** than the configured threshold; inactivity must reach the configured interval. The approved deployment policy is 50 MB and 30 days, with the byte convention and all concrete values set by the installer. No threshold or quota is embedded in runtime code. A missing expiry policy retains files; invalid settings refuse destructive maintenance. The warning percentage must be 1–100. Administrators can override their group storage limit using the existing configuration table.

Existing references receive a fresh `retention_started_at` at upgrade. Their original creation time stays unchanged, and their new `last_download_at` remains null. This gives historical files a full first interval without inventing pre-upgrade download evidence. New references start their interval at admission. A fresh authenticated download approved by the service updates the clock. Retrying the same request ID, a denied ACL/budget request or delayed provider financial logs does not update it. An approved request can subsequently fail at the provider; this clock records server approval, not proven delivery.

## Expiration and collection

Maintenance tries the existing quota lock and skips a busy pass instead of waiting on a writer. The original scheduled tick calls service-only `file_transfer_expire` before checking whether its queue is empty; an idle file therefore creates collection work even when nothing was previously queued. The HTTP collector repeats this bounded, idempotent check for manual invocations and uses the existing blob collector. Project membership is determined by `identity.device_projects`, including topic normalization through the existing source-group function. Small files and project-bound groups are excluded. A live download capability defers expiry. Old unregistered public-media pointers are left to the separately coordinated private-media migration; this release collects registered blobs only.

Expiry marks the group reference and returns `status: expired` from the same authorized download entry point, without a URL or a new download reservation. It preserves the message, item, versions, SHA and blob identity. Forwarding an expired source refuses before creating a reference. Clients can render “File expired” and offer the sender the existing upload/send action when a local copy is available. Client presentation is a separate acceptance cell, not proven by backend contracts.

The existing GC retains bytes while another live group reference, unexpired upload receipt, private task attachment, avatar or publication uses them. Successful physical deletion is confirmed through its existing claim token. Failures retain `deleting` state, capacity and normal retry backoff. Inventory changes to `gone` in the same completion transaction, preventing a late bookkeeping RPC from overwriting a fresh upload. Expired references keep their blob metadata; ordinary unreferenced objects keep the original metadata-deletion behavior. Provider deletion, cache invalidation, claim-token checks and retries use the existing implementation.

A genuinely new verified upload uses the existing size, ACL, reservation, SHA inspection and promotion path. Registration can reuse a physically collected blob identity and checks for a copy/GC race using the existing post-copy existence check. Only the new receipt reactivates that group's same-SHA references and resets their retention interval. Retrying an old receipt does neither, and different bytes create a new identity. No restore RPC is added. Already issued bearer URLs and bytes previously saved by readers cannot be recalled.

## Administrator usage

Authenticated `file_transfer_group_usage(chat, actor)` requires the actual source-group owner or administrator. It reuses the budget core's conservative storage total, including pending upload capacity and unconfirmed physical deletion. It returns `used_and_reserved_bytes`, `limit_bytes`, `warning` and `full`. Full storage refuses new uploads; it does not evict permanent files. Operators change the existing deployment data, not source code, to adjust limits.

## Verification and rule ownership

Runtime changes are confined to additive releases and the existing GC scheduler call. The migration guards each in-place extension against the exact preceding function text; an unexpected predecessor aborts the release. Previously published releases remain unchanged. Repeated installation uses the existing immutable release ledger.

| Code | Approved rule | Protection |
| --- | --- | --- |
| Reference clocks, first interval and bounded expiration | Non-project large-file expiry B | Configured strict size, idle threshold, project exclusion, no LRU |
| Download and forwarding checks | B | ACL before expiry disclosure, no signed URL or new charge for expired content |
| Existing upload/register extension | Existing upload/send reupload in B | Fresh receipt only; same SHA in same group; old retry cannot restore |
| Existing blob in-use/claim/finish extension | B and existing storage rules 3/4 | Shared references protected; physical confirmation before quota release; original retries/tokens |
| Administrator usage | B quota warning | Owner/admin only; existing conservative budget accounting |

The added database contracts cover size/time boundaries, policy changes, migration grace, missing/invalid policy, batch continuation, permanent-file quota pressure, project exclusion, request idempotence, denied reads, financial observations, shared content, physical-delete failure/retry and normal reupload before/after collection. Existing object-operation and GC token assertions remain intact. A new scheduling assertion verifies expiration precedes collection; the separate post-delete quota RPC is removed because completion now performs that update atomically. The original concurrent writer/collector test remains unchanged and proves that collection does not wait on a writer.
