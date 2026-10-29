# Self-managed gateway policies

Two partial policies for the Kong gateway of a self-managed Supabase CLI stack.
Neither is a complete Kong declarative configuration, and neither changes a
running gateway by itself. They are not applied by `pnpm run setup`; Supabase
Cloud gateway configuration is managed by Supabase.

## CORS: `storage-cors.json`

The source of the managed fields for the existing CORS plugins on the named
services.

- `rest-v1`: cache successful browser preflights for 600 seconds. Each actual REST
  request still passes through authentication and database authorization.
- `storage-v1` and `storage-v1-s3`: expose `Content-Range`, `Accept-Ranges` and
  `Content-Length` so browser downloads can inspect range responses.

Deployment tooling merges these fields into each service's existing CORS plugin. It
preserves unrelated exposed headers, origins, allowed methods, credentials, routes
and authentication plugins.

## Admin routes: `admin-routes.json`

`service_role_only` lists the gateway services that only the service-role key may
use. The CLI routes these administrative upstreams with CORS only, and
postgres-meta and the Studio MCP endpoint do no authentication of their own:

| Service | Path | Upstream |
| --- | --- | --- |
| `pg-meta` | `/pg/` | postgres-meta |
| `mcp` | `/mcp` | Studio MCP endpoint |
| `rest-admin-v1` | `/rest-admin/v1/` | PostgREST admin server |
| `analytics-v1` | `/analytics/v1/` | Logflare |
| `pooler-v2-ws` | `/pooler/v2/` | Supavisor |

Each listed service gets `key-auth` with `hide_credentials: true` and `acl` allowing
only group `admin`. One `service_role` consumer in that group holds the stack's
existing service-role JWT and secret key. Self-hosted Supabase uses the same
pattern. Deployment tooling reads both keys from the running gateway at deploy time,
never from source. Without a key, and with the anon or publishable key, these paths
must answer 401 or 403 at the gateway, never 2xx. Tenant routes are unchanged.

Studio and Vector reach postgres-meta and Logflare directly on the Docker network.
The CLI's PostgREST readiness probe sends the secret key, so it keeps working.
`{"service_role_only": []}` restores the CLI routing.

The CLI's Kong loads only `request-transformer` and `cors`. Tooling must not add
`key-auth` or `acl` to the file the container boots from: Kong would refuse it on
the next restart. Activate the secured configuration with a reload that enables the
two plugins; a restart then falls back to the boot file.

## Applying either policy

Read the policies from the selected backend revision. Validate the resulting Kong
configuration before reload, and reload gracefully. Restore the original
configuration if validation or response checks fail. Recreating the CLI stack
regenerates the gateway file, so apply the policies again afterwards.
