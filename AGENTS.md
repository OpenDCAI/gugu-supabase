# Community backend

This repository owns identity, messaging, sync, device RPC, permissions and basic file services. Official hosting, model gateway and payment implementations are maintained privately and do not belong here.

Use Node 24 and the pinned pnpm version. Tests that write data require a disposable loopback database. Preserve old deployment schemas and migration ledgers. Never apply the new foundation to an existing deployment or reset a database to make a test pass.

Functions start closed to API roles; each migration must grant only intended access. Preserve RLS, device ownership, message scope and file authorization. Do not turn denied or unavailable services into successful empty responses.

No credentials, tokens, user data or private deployment configuration in source, issues or logs.
