# DeepLook API

Self-hosted, open-source HTTP adapter for the [DeepLook browser](https://github.com/sayhitogambit/DeepLook). The browser engine and Chrome launch code live in that repository. This repository owns the HTTP contract, access control, request limits, and process boundary.

## Install from source

Use Node.js 22.14 or newer, npm, Git, and Google Chrome (or Chromium with `DEEPLOOK_CHROME` pointing to its executable). Installation is from source; these instructions do not depend on a published npm package. The public browser repository is pinned as the `vendor/deeplook` submodule. No GitHub personal access token is required to clone either repository.

```bash
git clone --recurse-submodules https://github.com/sayhitogambit/DeepLook-API.git
cd DeepLook-API
npm ci --prefix vendor/deeplook
npm run build --prefix vendor/deeplook
npm ci
npm run build
cp .env.example .env
chmod 600 .env
```

For an existing clone, run `git submodule update --init --recursive` before building. Generate your own administrator token locally:

```bash
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

Edit `.env`: replace the deliberately invalid administrator placeholder with the generated value and set `DEEPLOOK_CLI_PATH` to the absolute path of `vendor/deeplook/dist/cli.js` in your clone. Set `DEEPLOOK_CHROME` only if Chrome needs an explicit path. Keep your `.env` private. Then start the service:

```bash
node --env-file=.env dist/serve.js
```

The server does **not** automatically load `.env`. Node's explicit `--env-file` option loads it above; alternatively, export the settings in your shell or provide them through your deployment secret settings and run `npm run api`.

The service listens on `127.0.0.1:47231` by default. See [`.env.example`](.env.example) for all runtime settings and [credentials setup](docs/credentials.md) to create an account and its first browser key. A non-loopback bind requires `DEEPLOOK_API_TOKEN` or `DEEPLOOK_ADMIN_TOKEN`. Without either token, loopback `/v1/open` is unauthenticated and administrator routes are disabled; configure the administrator token for managed use. `/health` is always unauthenticated and checks the API process, not a full browser navigation.

`DEEPLOOK_MAX_CONCURRENT` controls the process-wide browser cap (default `2`, range `1–100`); account limits can only lower that cap for one tenant. The service checks that the CLI file exists before starting.

`DEEPLOOK_ADMIN_TOKEN` enables account management and stores state in `DEEPLOOK_DATA_DIR` (default: `./data`, relative to the process working directory). Browser key plaintext is returned only on creation or rotation. The store retains SHA-256 hashes, account settings, monthly counters, and a capped request log containing hostnames only. Its JSON file is replaced atomically with mode `0600` inside a mode `0700` directory. Use one process and one replica per data directory: the store is not a shared database, and sessions are process-local.

## HTTP contract

- `GET /health` returns `{"ok":true}` while the API process is running.
- `POST /v1/open` accepts `{"url":"https://example.com","timeoutMs":30000}`. `timeoutMs` is optional and can be 1–120000.
- Success returns the browser's JSON page object: `requestedUrl`, `finalUrl`, `httpStatus`, `title`, `text`, `truncated`, and `observed` browser details.
- Errors are JSON with `error` and `message`: `invalid_request` (400), `unauthorized` (401), `challenge`, `access_wall`, or `empty_content` (422), `quota_exceeded` (429), `navigation_failed` (502), `busy` (503), or `timeout` (504). Page failures can include the final URL, title, and a matched marker, but never their page text. An empty or invisible-only body is an error even if the upstream HTTP status is 200.

Only public HTTP(S) URLs on the standard port are accepted. The browser independently checks redirects and resources, pins public DNS answers, and blocks local and metadata addresses. The API can run two opens at once by default, aborts browser work after the deadline or client disconnect, and waits for process cleanup before freeing a slot. Browser CLI subprocesses receive only required OS settings and the optional `DEEPLOOK_CHROME` path, not the API's secrets or Node injection settings. Captchas are not solved.

`POST /v1/open` accepts either a named `dlk_` browser key or the optional migration token in `DEEPLOOK_API_TOKEN`. Named keys are attributed to an account and enforce its concurrency and monthly request limits. The static token keeps the original `/v1/open` behavior and is not valid for administrator routes. It bypasses named-account quota accounting and request logs, while the process-wide concurrency cap still applies. The administrator token itself cannot open pages.

## Account management contract

Every management request uses `Authorization: Bearer <DEEPLOOK_ADMIN_TOKEN>`. `externalId` is an account identifier chosen by your integrating application (for example, its stable internal user ID). All returned tokens, usage, logs, sessions, and pressure are scoped to that path account.

- `PUT /v1/admin/accounts/:externalId` idempotently ensures an account. Body: optional `name` and optional `limits` with `maxConcurrent` and `monthlyRequestQuota`.
- `GET /v1/admin/accounts/:externalId` returns the account, limits, and current-month usage.
- `GET|POST /v1/admin/accounts/:externalId/tokens` lists key metadata or creates a named key. Creation returns `{token, secret}` with the secret once.
- `POST /v1/admin/accounts/:externalId/tokens/:tokenId/rotate` replaces a key and returns its new secret once.
- `DELETE /v1/admin/accounts/:externalId/tokens/:tokenId` revokes a key and returns `204`.
- `GET /v1/admin/accounts/:externalId/usage` returns current-month request, success, failure, and remaining counts.
- `GET /v1/admin/accounts/:externalId/logs?limit=100` returns newest-first request metadata. Logs include request ID, key ID, hostname, timestamps, duration, and status; URL paths, queries, page content, and credentials are never retained.
- `GET /v1/admin/accounts/:externalId/sessions` lists active browser jobs. `DELETE .../sessions/:sessionId` requests cancellation and returns `202`.
- `GET /v1/admin/accounts/:externalId/pressure` returns active/concurrency and used/remaining quota counters. `remainingConcurrent` is capped by both the account limit and process-wide capacity.

Account and token identifiers are checked against the account in the URL. A token or active session from another account is returned as `404` through that path.

## Coolify

The production Dockerfile builds the public browser submodule `vendor/deeplook`, runs Chromium and the API as a nonroot user, and persists `/app/data`. See [deployment instructions](docs/coolify.md) for recursive checkout, volume permissions, secrets, sandbox settings, and smoke checks.

## Browser process protocol

The API runs the browser CLI with `open <url> --machine --timeout-ms <ms>` and expects one version 1 JSON envelope on stdout. This is an internal contract between the two repositories; the HTTP interface stays `/v1/open`. No GitHub package token is needed for API tests or installation. Deployments must build both repositories and set `DEEPLOOK_CLI_PATH` to the installed browser CLI.

```bash
npm test
```

Tests use a fake CLI and local HTTP fixtures. They do not require Chrome, external web access, or real credentials.

For the full HTTP → pinned CLI runner → sandboxed Chrome integration, initialize `vendor/deeplook`, run `npm ci --prefix vendor/deeplook`, then `npm run test:browser`. This suite uses local HTML fixtures and a named test key, checks rendering, challenge/access-gate/empty-content errors, renderer timeout, and account usage attribution. It needs Chrome but no external sites or real credentials.

`npm run test:container` builds the production image and runs that suite with external networking disabled, the bundled Chromium seccomp profile, restricted capabilities, and resource limits. The Compose example uses the same sandbox settings; see `docs/coolify.md` before deploying.

The optional CI `browser-integration` job is enabled with repository variable `DEEPLOOK_BROWSER_CI_ENABLED=true`. Public recursive checkout uses the default workflow token; a private engine access token is not required. Keep this job enabled for release validation; a skipped job is not evidence that the browser integration passed.

## Stopping and updating the service

SIGTERM and SIGINT stop accepting HTTP connections, reject pending admissions with `busy`, and cancel active browser requests. The service waits for owned CLI processes to exit, including their existing two-second termination escalation, before completing shutdown. Canceled managed requests are recorded as `canceled`; their admitted request still counts toward usage.

Responses finishing during shutdown close their idle keep-alive connections. Shutdown has an eight-second deadline, including incomplete HTTP bodies and disconnected handlers still awaiting DNS or storage; if draining exceeds it, the service closes connections and terminates itself with SIGKILL, which the supervisor should treat as a failed shutdown. This hard stop also handles native I/O that can prevent `process.exit()` from returning. Orderly shutdown exits 0. Configure the supervisor/container stop grace above eight seconds; the Compose example uses 15 seconds. No credentials or page content are included in shutdown messages.

Process-level tests cover both signals, cleanup of an owned subprocess, a SIGTERM-resistant CLI, incomplete request draining, cancellation attribution persisted to disk, admission interrupted during URL validation, and storage I/O remaining after a client disconnects.

## Email and contact

The API does not send email and has no SMTP configuration. Emailing credentials or notifications is the responsibility of the integrating application; see [the optional email integration notes](docs/credentials.md#optional-email-integration). For project support, contact [support@getdeeplook.dev](mailto:support@getdeeplook.dev). This contact address is not an SMTP credential or a sender identity for your deployment.

## License

Original code in this repository is licensed under [Apache-2.0](LICENSE). The browser submodule and bundled third-party security profile retain their own license notices; see the browser repository and [Playwright's license](security/PLAYWRIGHT-LICENSE).
