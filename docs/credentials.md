# Configure your own credentials

Each installation uses credentials created by its operator. DeepLook API does not require a DeepLook cloud API key, the project owner's credentials, a GitHub personal access token, or an email account to run. Install the public repositories from source as described in the [README](../README.md).

## Administrator and browser access

| Credential | Who creates it | Where to use it |
| --- | --- | --- |
| `DEEPLOOK_ADMIN_TOKEN` | You generate it locally and configure the server | `Authorization: Bearer …` on `/v1/admin/...` from a trusted backend |
| Named browser key (`dlk_...`) | Your running API creates it for an account | `Authorization: Bearer …` on `POST /v1/open` |
| Optional `DEEPLOOK_API_TOKEN` | You generate a different local secret | Legacy `POST /v1/open` access without named-account quota accounting or request logs |

The administrator token does not authorize browser opens. Browser keys and the legacy token do not authorize administrator routes. Never place the administrator or legacy server token in frontend JavaScript. Give browser keys only to the client or application intended to use them.

Generate an administrator token on your own computer:

```bash
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

Store the generated value in your deployment's secret settings or a private local `.env`. If you need the optional legacy token, run the command again for a distinct value. Both settings accept 32–512 characters with no whitespace and cannot have equal values. The placeholders in [`.env.example`](../.env.example) are deliberately invalid; replace them before starting.

A local `.env` is only a template until you explicitly load it:

```bash
node --env-file=.env dist/serve.js
```

The API does not load `.env` automatically. Alternatively, export the environment variables and run `npm run api`. Environment loading by Docker Compose is a separate feature of Compose; it does not make the API itself a dotenv loader.

With an administrator token configured, named browser credentials and account state persist in `DEEPLOOK_DATA_DIR`. Without an administrator token, management routes are disabled. When neither server token is configured, loopback browser access is unauthenticated; non-loopback startup is rejected. Use authenticated access for deployments.

## Create your first account and key

Start the service with your administrator token first. In a separate Bash terminal, set the API URL and read the same administrator secret without putting its literal value in command history. Node's `--env-file` in the server terminal does not export credentials to this client terminal.

```bash
export DEEPLOOK_URL=http://127.0.0.1:47231
read -r -s -p 'Administrator token: ' DEEPLOOK_ADMIN_TOKEN
printf '\n'
export DEEPLOOK_ADMIN_TOKEN

curl --fail-with-body "$DEEPLOOK_URL/health"

curl --fail-with-body -X PUT "$DEEPLOOK_URL/v1/admin/accounts/my-app" \
  -H "Authorization: Bearer $DEEPLOOK_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"name":"My application","limits":{"maxConcurrent":2,"monthlyRequestQuota":10000}}'

curl --fail-with-body -X POST "$DEEPLOOK_URL/v1/admin/accounts/my-app/tokens" \
  -H "Authorization: Bearer $DEEPLOOK_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"name":"My application backend"}'
```

`my-app` is your chosen stable account identifier. The account defaults are two concurrent opens and 10,000 requests per UTC calendar month. `maxConcurrent` accepts `1–100`; `monthlyRequestQuota` accepts `1–100000000`. Account concurrency cannot exceed the process's available capacity. Admitted requests, including failed and canceled browser jobs, count toward quota; rejected requests before admission do not.

Key creation returns `{token, secret}`. Save `token.id` for later rotation or revocation, and store `secret` privately in the calling application. This is the only time that secret is returned, apart from creating a new secret on rotation. The server stores its SHA-256 hash; later key-list responses contain metadata only. Avoid recording or sharing the creation response.

Use that newly returned `secret` for an authenticated page read:

```bash
read -r -s -p 'Browser key: ' DEEPLOOK_BROWSER_TOKEN
printf '\n'
export DEEPLOOK_BROWSER_TOKEN

curl --fail-with-body -X POST "$DEEPLOOK_URL/v1/open" \
  -H "Authorization: Bearer $DEEPLOOK_BROWSER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://example.com","timeoutMs":30000}'
```

A health response confirms the API is alive; a successful page response separately checks browser launch and navigation. Bot checks, access gates, empty pages, navigation failures, quotas, and timeouts return documented errors. Captchas are not solved.

## Rotate, revoke, and back up

Use the administrator routes in the [HTTP contract](../README.md#account-management-contract) to list key metadata, rotate a key, or revoke it. Rotation replaces the old secret immediately; update the calling application with the newly returned secret. Revocation prevents future authentication and does not itself cancel an already active session; use the account's session cancellation route if needed.

To rotate an administrator or legacy token, generate a new value, update the server secret settings, and restart the service. Update trusted callers that hold the changed credential. Named browser keys persist through a server restart when the same data volume is retained.

Back up the private `DEEPLOOK_DATA_DIR` volume, including `accounts.json`. It contains account settings, key hashes, monthly usage, and retained hostname-only request metadata. Restoring it restores that state; it cannot recover plaintext browser keys. Keep one API process/replica per data directory, and retain a container stop grace above the eight-second shutdown deadline (the supplied Compose file uses 15 seconds).

## Optional email integration

DeepLook API does not send email and does not consume SMTP settings. Your integrating application may independently email notifications or onboarding messages. Configure its own email provider and sender domain; the public project contact, [support@getdeeplook.dev](mailto:support@getdeeplook.dev), is not your sender mailbox or SMTP login.

If your application's mail library supports these conventional variables, its separate environment might look like this. The names are illustrative and are not API settings. Replace the `example.com` addresses and ask your mail provider for its host, port, and TLS requirements.

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=mailer@example.com
MAIL_FROM=notifications@example.com
# Supply SMTP_PASSWORD privately through the application's environment or
# deployment secret store; never hard-code it or commit it to the repository.
```

Use your own provider-issued SMTP password in that application's `SMTP_PASSWORD` environment variable. Adding these variables to DeepLook API does not enable email delivery.
