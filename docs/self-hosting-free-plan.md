# Free plan limits and troubleshooting

Companion to [self-hosting.md](self-hosting.md). Figures are from [supabase.com/pricing](https://supabase.com/pricing) and [Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits) as of October 2026. Check those pages before relying on them.

## Supabase free plan

| Resource | Free plan | What it means for Gugu |
| --- | --- | --- |
| Active projects | 2 per organization | Use one for Gugu; paused projects do not count |
| Inactivity | Paused after 1 week | Clients cannot connect until you restore it in the dashboard |
| Database size | 500 MB | Messages, contacts and metadata |
| File storage | 1 GB, max 50 MB per file | Attachments and avatars. Gugu's own buckets cap attachments at 25 MB and avatars at 5 MB |
| Egress | 5 GB + 5 GB cached | Attachment downloads count here |
| Edge Function invocations | 500,000 / month | Attachment upload, commit and download, server sign-in |
| Realtime | 200 concurrent connections, 2 M messages / month, 256 KB per message | Roughly one connection per running client |
| Monthly active users | 50,000 | — |
| Built-in email | 2 emails / hour, organization members only, default templates | Not usable for sign-in; [configure SMTP](self-hosting-smtp.md) |
| Backups | None | Export your data yourself if it matters |

A small team fits comfortably. The first limits you are likely to meet are pausing after a quiet week and storage if people share large files.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `pnpm setup` → `Unknown option: 'client-dir'` | `setup` is a built-in pnpm command | `pnpm run setup` |
| Setup: `Set SUPABASE_ACCESS_TOKEN locally` | No personal access token in the environment | Create one (guide step 2) and export it |
| Setup: `Supabase Management API ... HTTP 401/403` | Token expired, or scoped to another project | Create a token scoped to this project with Full access |
| Setup: `Use a new dedicated project` | The database already has Gugu or other schemas | Use a new, empty project |
| Setup prints `WARNING: sign-in emails do not contain the 6-digit code yet` | No custom SMTP; the free plan blocks template edits with the built-in sender | Configure SMTP, run setup again |
| Sign-in: "too many requests" right away | Built-in sender's 2 emails / hour, or the same address asked within 60 seconds | Configure SMTP and raise the email rate limit; wait 60 seconds between codes |
| Sign-in: `Email address not authorized` | Built-in sender only mails members of your Supabase organization | [Configure SMTP](self-hosting-smtp.md) |
| Sign-in: email address rejected | Supabase rejects some domains, e.g. `example.com` | Use a real address |
| Email arrives with a link but no code | Templates were not updated | Configure SMTP, re-run setup, or add `{{ .Token }}` to the Magic Link and Confirm Signup templates |
| The code is 8 digits, the client accepts 6 | Project default OTP length is 8 | Re-run setup (sets 6) or set the email OTP length to 6 in the Email provider settings |
| `dev-app.sh` fails in `verify-dev-native` with `pty.node: No such file` | Native modules not built for Electron yet | `pnpm rebuild:native` |
| Clients stop connecting after a quiet week | Free project paused | Restore it in the dashboard |
| A local agent does not answer | The agent CLI is not signed in on this machine | Sign in to that CLI (e.g. run `claude` once) or pick another installed CLI |

Function logs: dashboard → Edge Functions → `attachments` / `server-login` → Logs. Auth logs: Logs → Auth.
