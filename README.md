# DeepLook API

Private HTTP adapter for the [DeepLook browser](https://github.com/sayhitogambit/DeepLook). The browser engine and Chrome launch code live in that repository. This repository owns the HTTP contract, access control, request limits, and process boundary.

## Run locally

Build DeepLook first, then point this service at its built CLI. Node.js 22.14 or newer and Google Chrome are required for real page opens.

```bash
cd /path/to/DeepLook
npm ci && npm run build

cd /path/to/DeepLook-API
npm ci && npm run build
DEEPLOOK_CLI_PATH=/path/to/DeepLook/dist/cli.js npm run api
```

The service listens on `127.0.0.1:47231`. Set `DEEPLOOK_HOST` and `DEEPLOOK_PORT` to change the address. A non-loopback bind requires `DEEPLOOK_API_TOKEN`; clients send `Authorization: Bearer <token>`. Keep the token in the environment and use TLS for remote access. The service checks that the CLI file exists before starting. It does not store credentials or page data.

## HTTP contract

- `GET /health` returns `{"ok":true}` while the API process is running.
- `POST /v1/open` accepts `{"url":"https://example.com","timeoutMs":30000}`. `timeoutMs` is optional and can be 1–120000.
- Success returns the browser's JSON page object: `requestedUrl`, `finalUrl`, `httpStatus`, `title`, `text`, `truncated`, and `observed` browser details.
- Errors are JSON with `error` and `message`: `invalid_request` (400), `unauthorized` (401), `challenge` (422), `navigation_failed` (502), `busy` (503), or `timeout` (504). A challenge response can include the final URL, title, and matched marker, but never its page text.

Only public HTTP(S) URLs on the standard port are accepted. The browser independently checks redirects and resources, pins public DNS answers, and blocks local and metadata addresses. The API can run two opens at once by default, aborts browser work after the deadline or client disconnect, and waits for process cleanup before freeing a slot. Captchas are not solved.

## Browser process protocol

The API runs the browser CLI with `open <url> --machine --timeout-ms <ms>` and expects one version 1 JSON envelope on stdout. This is an internal contract between the private repositories; the HTTP interface stays `/v1/open`. No private GitHub package token is needed for API tests or installation. Deployments must build both repositories and set `DEEPLOOK_CLI_PATH` to the installed browser CLI.

```bash
npm test
```

Tests use a fake CLI and local HTTP fixtures. They do not require Chrome, external web access, or real credentials.
