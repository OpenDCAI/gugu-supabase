# Custom SMTP for sign-in email

Companion to [self-hosting.md](self-hosting.md). Gugu signs users in with a 6-digit code sent by email, so a working installation needs your own SMTP service. Skip this and nobody can sign in.

## Why the built-in sender is not enough

Supabase gives every project a built-in sender for trying things out. Per [Supabase's SMTP guide](https://supabase.com/docs/guides/auth/auth-smtp), it:

- delivers only to email addresses of your Supabase organization's members (others get `Email address not authorized`);
- sends at most 2 emails per hour per project;
- uses fixed default templates. These contain a sign-in link but no code, and the dashboard shows "Set up custom SMTP to edit templates".

Custom SMTP removes all three limits.

## 1. Pick a provider and get SMTP credentials

Any SMTP service works. You need a host, a port, a username, a password and a From address on a domain you have verified with the provider. Step-by-step guides written for Supabase:

| Provider | Guide | Typical settings |
| --- | --- | --- |
| Resend | [Send emails using Supabase with SMTP](https://resend.com/docs/send-with-supabase-smtp) | `smtp.resend.com`, port 465, user `resend`, password = API key |
| Brevo | [Supabase SMTP with Brevo](https://www.brevo.com/integrations/supabase/) | `smtp-relay.brevo.com`, port 587, password = SMTP key (not the API key) |
| AWS SES | [Send email using the SES SMTP interface](https://docs.aws.amazon.com/ses/latest/dg/send-email-smtp.html) | Region-specific host, IAM-generated SMTP credentials |
| Postmark | [Send email with SMTP](https://postmarkapp.com/developer/user-guide/send-email-with-smtp) | Server API token as user and password |
| SendGrid | [Getting started with SMTP](https://www.twilio.com/docs/sendgrid/for-developers/sending-email/getting-started-smtp) | User `apikey`, password = API key |
| ZeptoMail | [SMTP configuration](https://www.zoho.com/zeptomail/help/smtp-home.html) | From the Mail Agent's SMTP page |

Several of these have free tiers that cover a small team; check their pricing pages. Add the SPF, DKIM and DMARC records the provider asks for, or codes may land in spam.

## 2. Turn on custom SMTP in Supabase

1. Dashboard → your project → **Authentication → Emails → SMTP Settings** ([direct link](https://supabase.com/dashboard/project/_/auth/smtp)).
2. Enable **Custom SMTP** and fill in: sender email (e.g. `no-reply@auth.example.com`), sender name (e.g. `Gugu`), host, port, username and password. Save.
3. Supabase now allows 30 emails per hour. Raise it under **Authentication → Rate Limits** to fit your users ([rate limits](https://supabase.com/docs/guides/auth/rate-limits)).

The same settings can be applied with the Management API (`PATCH /v1/projects/{ref}/config/auth` with `smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`, `smtp_admin_email`, `smtp_sender_name`); see the Supabase guide above.

## 3. Re-run setup

```sh
pnpm run setup --client-dir ../gugu
```

With SMTP present, setup adds the 6-digit code to the **Magic link or OTP** and **Confirm sign up** templates and keeps any other text you wrote. It does not add the code twice. The earlier `WARNING: sign-in emails do not contain the 6-digit code yet` line no longer appears.

You can edit the templates yourself instead (Authentication → Emails → Templates). Keep `{{ .Token }}` in both: new users receive **Confirm sign up**, returning users **Magic link or OTP**.

## 4. Check it

Sign in from the client with an address outside your Supabase organization. The email should come from your sender address and contain a 6-digit code. If it does not arrive, check the provider's sending logs and Supabase **Logs → Auth**.
