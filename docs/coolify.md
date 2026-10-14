# Coolify deployment

This image builds the API repository and the private DeepLook browser repository as separate projects. DeepLook must be checked out as the relative private Git submodule `vendor/deeplook`; its source is not copied into this repository.

## Repository preparation

From the API repository, add the browser once and commit only the submodule pointer and `.gitmodules`:

```bash
git submodule add ../DeepLook.git vendor/deeplook
git commit -m "build: attach private DeepLook browser"
```

Connect a Coolify GitHub App with read access to both private repositories and enable recursive submodule checkout. A repository-scoped GitHub deploy key cannot normally read the second private repository. Do not put a GitHub token in the Dockerfile, build arguments, repository URL, or environment variables.

## Coolify resource

Create one Dockerfile application from the DeepLook API repository.

- Dockerfile: `Dockerfile`
- Container port: `47231`
- Health check: `GET /health`
- Persistent storage: mount a volume at `/app/data`
- Network: connect Nymetric over Coolify's private network on port `47231` (recommended)
- Replicas: `1`

Use one replica for this milestone. Account data is an atomic local JSON file and active browser sessions live in the process. Multiple replicas would have separate quota counters and cannot cancel each other's sessions.

Use a named Coolify volume initialized from the image, or make an existing mount writable by UID/GID `10001:10001`. The container deliberately does not start as root, so a root-only bind mount will make account creation fail.

Set these runtime variables:

```text
DEEPLOOK_HOST=0.0.0.0
DEEPLOOK_PORT=47231
DEEPLOOK_MAX_CONCURRENT=2
DEEPLOOK_DATA_DIR=/app/data
DEEPLOOK_CLI_PATH=/app/vendor/deeplook/dist/cli.js
DEEPLOOK_CHROME=/usr/bin/chromium
DEEPLOOK_ADMIN_TOKEN=<a long random secret>
```

During migration, `DEEPLOOK_API_TOKEN` may also be set. It continues to authorize `POST /v1/open` and does not authorize management routes. New `dlk_` browser keys are created through the administrator routes and can be used alongside that static token.

Configure Nymetric with the DeepLook API resource's private Coolify hostname and keep the browser API off the public Internet. If direct external access is deliberately needed, assign a separate domain, terminate TLS at Coolify, and restrict ingress; never expose plain HTTP. Keep `DEEPLOOK_ADMIN_TOKEN` only in Coolify's secret environment settings. Back up the `/app/data` volume; restoring `accounts.json` restores accounts, key hashes, usage, and retained request logs. Browser key plaintext cannot be recovered and is returned only when a key is created or rotated.

Use the same private URL for Nymetric's `DEEPLOOK_MANAGEMENT_URL`, `DEEPLOOK_GATEWAY_URL`, and `DEEPLOOK_API_URL`. Give Nymetric the matching `DEEPLOOK_ADMIN_TOKEN`, the separate legacy `DEEPLOOK_API_TOKEN`, and `DEEPLOOK_ACCOUNT_ID=nymetric-owner`. Neither server secret belongs in browser JavaScript.

## Smoke check

After deployment, first ensure an account, then create its first browser key:

```bash
curl --fail-with-body -X PUT "$DEEPLOOK_URL/v1/admin/accounts/nymetric-owner" \
  -H "Authorization: Bearer $DEEPLOOK_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"Nymetric","limits":{"maxConcurrent":2,"monthlyRequestQuota":10000}}'

curl --fail-with-body -X POST "$DEEPLOOK_URL/v1/admin/accounts/nymetric-owner/tokens" \
  -H "Authorization: Bearer $DEEPLOOK_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"Nymetric production"}'
```

The returned browser key is an end-user credential for `/v1/browser/open`; show or copy it once and store it only in the calling application. Nymetric does not need this key in its runtime environment. Later token-list responses contain metadata only.
