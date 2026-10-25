# Self-managed gateway CORS policy

`storage-cors.json` is the source of the managed fields for the existing CORS
plugins on the named Supabase Kong services. It is a partial policy, not a complete
Kong declarative configuration.

- `rest-v1`: cache successful browser preflights for 600 seconds. Each actual REST
  request still passes through authentication and database authorization.
- `storage-v1` and `storage-v1-s3`: expose `Content-Range`, `Accept-Ranges` and
  `Content-Length` so browser downloads can inspect range responses.

Self-managed deployment tooling must read this file from its selected backend
revision and merge these fields into each service's existing CORS plugin. Preserve
unrelated exposed headers, origins, allowed methods, credentials, routes and
authentication plugins. Validate the resulting Kong configuration before reload
and restore the original configuration if validation or response checks fail.

This file does not change a running gateway by itself. It is not applied by
`pnpm run setup`, and Supabase Cloud gateway configuration is managed by Supabase.
