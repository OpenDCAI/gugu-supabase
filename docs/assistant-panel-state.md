# Durable assistant panel state

The assistant panel reads saved account data independently of an execution host.
Today and diary retain their existing chat-folder document. Other domains use
`identity.assistant_panel_items`; committed edits also create ordered records in
`identity.assistant_panel_changes`. These tables are private to the signed-in
owner and the marked personal assistant. They do not start a device or model turn.

This release supplies the backend contract. Runtime application and desktop/mobile
readers are separate changes; installing it alone does not migrate an existing
assistant's files or change the interface.

## APIs

All functions below are in the `identity` schema. Only `authenticated` can call
them. The owner comes from `auth.uid()`, never a request field. Table access is
SELECT-only with RLS; internal helpers and direct writes are closed to clients.

| RPC | Arguments | Result |
| --- | --- | --- |
| `assistant_panel_snapshot` | `p_assistant` | `{version:1, revision, items, application}` from one database snapshot; an unprepared account has no collection marker; pending/failed application entries identify the affected resource without copying its body |
| `assistant_panel_commit` | `p_assistant`, UUID `p_operation_id`, `p_domain`, `p_resource_key`, bigint `p_expected_revision`, `p_operation`; optional `p_data`, `p_body_item_id`, `p_body_sha256`, `p_device_id`, `p_runtime_instance_id` | `{operationId, revision, status}` after atomically committing the resource and its application record |
| `assistant_panel_pending` | `p_assistant`, `p_runtime_instance_id` | `{revision, changes}` in committed order, including failed changes that still require application |
| `assistant_panel_ack` | `p_assistant`, `p_runtime_instance_id`, `p_operation_id`; optional `p_error_code` | Item-specific application receipt; only success removes a change from the pending set |
| `assistant_panel_admit` | `p_assistant`, `p_runtime_instance_id`, `p_expected_revision` | `{admitted:true, revision}` only when the head still matches and all preceding panel changes have been applied; otherwise identifies the pending item or raises a version conflict |

Revisions in JSON results are decimal strings. An absent resource has expected
revision `0`. A stale expected revision returns SQLSTATE `40001`; retain the draft
and re-read before editing. An operation ID retry with the identical request
returns its existing receipt. Reusing the ID for different input is rejected.

The operation is `save`, `remove`, `enable`, `disable`, `prepared` or `error`.
Enable/disable accept an existing schedule/integration and no replacement data;
they preserve the current prompt, schedule, body and other metadata. Remove
accepts no content. A removed stable resource ID remains revoked; a late import
cannot republish it even if it supplies the tombstone's current version.

## Data and preparation

Supported domains are `tasks`, `schedules`, `memory`, `personality`,
`integrations`, `voice-notes`, `capabilities`, `device-notes`, `files` and `skills`.
The migration contains each domain's metadata field allowlist. Integration data
contains account display/authorization metadata, never credentials or nested
configuration. Credentials stay in the existing encrypted store.

Collection markers use `__collection__`, or `__collection__:<device ID>` for an
individual device. Only the actual runtime publisher can submit `prepared` or
`error`. A prepared marker requires `{state:"ready", schemaVersion:1, itemCount}`
whose count matches all non-deleted resources in that collection. A failed source
uses `{state:"error", schemaVersion:1, errorCode}` and leaves existing items intact.
No marker means not yet prepared, not a successfully read empty collection.

The snapshot and pending APIs return complete data or an explicit response-budget
error; they never truncate a collection and present the remainder as absent.
Snapshot reads never create an initialization row or enqueue a wake command.

## Bodies and deletion

Large text and audio use existing file uploads into the exact owner/personal
assistant private DM. Commit a complete stored `file` object and its SHA-256;
the hash must match `chat.file_blobs`. Other chats, collaboratively mutable
documents and references already assigned to another panel resource are refused.
Today remains a collaborative document and is not subject to this file-body API.

A published body ID is immutable: changing its blob in place is rejected. Upload
a new object and atomically commit its reference instead. Failed uploads or
uncommitted objects continue through the existing file cleanup mechanisms.

Removal atomically writes the tombstone/application record and deletes all body
objects previously published for that resource through the existing authorized
workspace deletion API. Any deletion failure rolls back the complete operation.
Deleted body text is never copied into the removal record; it retains only the
resource/device and the paths or account IDs needed for local cleanup. File
storage bytes continue through existing retention and garbage collection.

The runtime must delete local originals, memory-index references and retrieval
caches, reject reads of revoked files and append a structured committed-change
notice before the next request. It preserves native conversation context and its
prefix; this protocol does not reset sessions or erase historical chat messages.

## Writers, failure and admission

Panel commits do not require a runtime. Runtime publication supplies a current
`runtime_instances` lease owned by the account. Assistant-owned data requires the
assistant's assigned device; device/task metadata can originate from its actual
owned device. A still-live publisher cannot be replaced by another instance.
Expired, unowned or revoked assistant bindings are rejected. A runtime cannot
overwrite a resource with an unapplied panel change.

The per-assistant control row serializes all commits, acknowledgements and
admission. Revisions are allocated after acquiring the lock, so sequence order
cannot skip a smaller, not-yet-committed change. Readers see the previous complete
state until the transaction commits. A private `assistant_panel_changed` event on
the existing owner user-events bus hints that readers should re-fetch, including
application receipts that do not change the desired-state revision; events are
not the durable mutation queue and never constitute a new assistant task.

Before ordinary messages or scheduled work enter the assistant, the runtime reads
pending changes, applies them idempotently and acknowledges successful effects in
order. It must wait for real local success before acknowledging. After brief
bounded retries, failure is recorded using a non-sensitive uppercase error code;
admission remains blocked and identifies the domain/resource that needs attention.
The saved desired value is retained. A crash between a local effect and its
acknowledgement is handled by verifying/reapplying the same operation ID.

Finally call admission with the observed head revision. A concurrent earlier edit
requires another application pass; an edit committed after admission is an
in-turn App change handled at the existing tool boundary. No API here delivers a
chat message, wakes a host, or acknowledges actual model execution.
