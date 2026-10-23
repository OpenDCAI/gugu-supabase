# Topic resource containers

Topics have their own message streams and participation subscriptions. Their shared files and App data belong to the source group or direct chat. Reading or editing a shared file does not join a topic or change its message read position.

Chat-addressed workspace operations accept a topic ID and resolve it to the source container. Returned entries carry the source `chat_id`. Item-addressed metadata, signed downloads and collaborative editing require the acting user's actual membership in that container. Delegating to an agent proves who may act as it; the agent must itself be a source member.

## Upgrade

The `topic_source_resources` release moves existing workspace metadata within its installation transaction. It preserves file/document IDs, user-directory IDs, content, Yjs state, epochs, versions, pinned message references and blob references. Existing source filenames win collisions; incoming files and ordinary directories use the normal filename allocator. Distinct boards keep their own IDs and contents. System attachment directories are consolidated, adopting an existing topic directory when the source has none.

Physical Storage keys and content-addressed blobs do not move. Old keys containing a topic prefix remain physical addresses, authorized through the source. Do not delete objects merely because their key starts with a topic ID. Missing legacy objects remain missing; the release does not manufacture replacement bytes.

The release refuses unreachable trees, invalid sources and redundant system directories with content or database references. A failure rolls back the definitions and metadata together. Do not edit historical releases, reset the installation ledger or disable foreign keys to force an upgrade.

Deploy the paired file service before applying the release. Existing connections are reauthorized through `files_authorize` against each item's current container, including delegated identity checks. The existing revocation channel triggers a recheck after the metadata move; topic participation changes do not revoke source file access.

## Client coordination

This is a resource-semantics change and requires the paired client update for topic file/App surfaces. Old clients may still send and read topic messages, but strict topic-versus-file-container checks can reject files, and topic-scoped file watches miss source updates. Some Apps that use returned file entries continue working; full old-client compatibility is not promised.

Prepare client updates and a topic-resource maintenance window before upgrading a deployment. Shared Apps should open in the source chat's shared slot. Public message RPC shapes and App context fields do not change, and no second topic storage or compatibility write path is maintained.

Before deployment, inventory topic resources, versions, blob references, collisions, missing legacy objects and participants who are not source members. Such participants are not automatically enrolled into the source; resource access will be denied until membership is explicitly resolved. Review this independently for each deployment.
