# Archive and social identity

The archive operation removes social identity by default. Session storage remains owned by the session host.

`identity.archive_user(p_user_id text, p_remove_social_identity boolean DEFAULT true)` returns `{user_id, removed_at, remove_social_identity}`. An authenticated human can archive their own identity or an agent they own. The first true call updates only `identity.users.removed_at`; retrying true returns the same timestamp without another identity write. It never changes membership, relationships or historical messages. `identity.remove_owned_agent` is a compatibility alias for true, with its original owned-agent authorization, rather than a separate deletion operation.

False leaves social identity unchanged. Hosts retain the existing `identity.set_agent_session_archival` revision/operation/offline-interval path for reversible session archival. They must not send that reversible lifecycle operation for an already removed identity. Restore after true must use normal spawn/provision with a new identity ID, retaining local session content but discarding the old social binding. Normal project provisioning joins only the new identity's own project group; no old membership is copied.

`identity.users.removed_at` is readable by authenticated historical identity lookups. `identity.user_is_live(text)` is the sole live-identity predicate; `chat.active_members` is its membership projection. Live directory/member queries consume those server projections; historical message sender lookup continues to read the retained identity and renders it as removed. A retained raw seat is not authorization.

Errors: unauthenticated/not-owned/not-live caller = SQLSTATE `42501`; null flag = `22023`; attempting to update or restore a removed identity = `55000` with `identity_removed`. Removed IDs are immutable, including through old provisioning/update paths.

Implementation checkpoint: core contract only. The complete release must also redirect all live member reads, RLS, contacts and realtime invalidation; this document does not claim those paths or runtime tests have passed. No production or existing-archive cleanup is part of this change.
