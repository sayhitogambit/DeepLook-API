# Coolify deployment

This image builds the API repository and the public [DeepLook browser repository](https://github.com/sayhitogambit/DeepLook) as separate projects. The browser is pinned as the Git submodule `vendor/deeplook`; its source is not copied into this repository. Deployment builds from source and does not require a published npm package.

## Coolify Compose option

For Coolify versions whose custom Docker option parser truncates hyphenated security values, use the Docker Compose build pack with `/compose.coolify.yaml`. It builds the same pinned browser/API source, keeps the Chromium sandbox and security/resource restrictions from `compose.yaml`, and exposes port 47231 only to the proxy network. Assign `https://api.your-domain.example` to the `api` service in Coolify; keep one replica and the persistent `data` volume. The optional legacy demo token is supplied only through runtime variables. This avoids weakening the sandbox to accommodate a platform parser bug.

## Repository preparation

Clone the public API repository recursively:

```bash
git clone --recurse-submodules https://github.com/sayhitogambit/DeepLook-API.git
cd DeepLook-API
```

For an existing clone, run `git submodule update --init --recursive`. The committed `.gitmodules` resolves the browser repository under the same GitHub owner. Do not add another submodule or replace the pinned browser revision during deployment.

Configure Coolify to fetch submodules recursively and check that `vendor/deeplook/package.json` is present in the build checkout. Both source repositories are public; no private GitHub personal access token, cross-repository deploy key, or package registry credential is needed. Coolify may use its normal GitHub connection for deployment events. Never embed credentials in repository URLs, Dockerfiles, or build arguments.

## Coolify resource

Create one Dockerfile application from the DeepLook API repository.

- Dockerfile: `Dockerfile`
- Container port: `47231`
- Health check: `GET /health`
- Persistent storage: mount a volume at `/app/data`
- Network: connect your calling application over Coolify's private network on port `47231` (recommended)
- Replicas: `1`

Use one replica and one API process per data directory. Account data is an atomic local JSON file and active browser sessions live in the process. Multiple replicas would have separate quota counters and cannot cancel each other's sessions.

The pinned browser requires the Chromium sandbox. The image includes Debian's `chromium-sandbox` package. Docker's default seccomp policy can deny the namespace operations Chromium needs: use the bundled `security/playwright-seccomp.json` profile with `security-opt seccomp=<absolute-host-path>`. This preserves syscall filtering while allowing the browser to establish its own sandbox. The profile is the unmodified Playwright v1.56.1 file, SHA-256 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`, from [Playwright v1.56.1](https://github.com/microsoft/playwright/blob/v1.56.1/utils/docker/seccomp_profile.json). Its Apache-2.0 license is included at [`security/PLAYWRIGHT-LICENSE`](../security/PLAYWRIGHT-LICENSE).

Validate sandboxed startup on the target Docker host before exposing the service. Do not add `--no-sandbox`, run the container privileged, or disable its security profile to make a failing smoke test pass. Chrome's OS environment and the CLI subprocess environment exclude administrator credentials.

`compose.yaml` supplies the seccomp profile, drops capabilities except `SYS_CHROOT`, prevents gaining privileges, limits memory/CPU/processes, persists account state, and publishes only a loopback port for an HTTPS reverse proxy. The upstream profile permits Chromium's sandbox `chroot` syscall only when `SYS_CHROOT` is in the capability bounding set; the service still runs as UID 10001. Generate your own `DEEPLOOK_ADMIN_TOKEN` as described in [credentials setup](credentials.md) and supply it through the deployment secret environment before `docker compose up --build`. Docker Compose can load its own `.env` for interpolation; the Node API itself does not automatically read `.env`. In Coolify, configure the equivalent container security options, or deploy the Compose resource with the profile available on the host. Validate `npm run test:container` on that host; it runs the full browser fixture suite with external networking disabled and the same security/resource restrictions. A host that still denies user namespaces needs an appropriate host policy before it can serve requests.

Use a named Coolify volume initialized from the image, or make an existing mount writable by UID/GID `10001:10001`. The container deliberately does not start as root, so a root-only bind mount will make account creation fail.

Set these runtime variables:

```text
DEEPLOOK_HOST=0.0.0.0
DEEPLOOK_PORT=47231
DEEPLOOK_MAX_CONCURRENT=2
DEEPLOOK_DATA_DIR=/app/data
DEEPLOOK_CLI_PATH=/app/vendor/deeplook/dist/cli.js
DEEPLOOK_CHROME=/usr/bin/chromium
DEEPLOOK_ADMIN_TOKEN=<generate-locally>
```

Replace `<generate-locally>` with your own generated 32–512-character secret containing no whitespace; the example placeholder is intentionally invalid. Keep it in Coolify's runtime secret settings. The Docker image already sets the non-secret defaults above.

During migration, `DEEPLOOK_API_TOKEN` may also be set to a separately generated secret. It continues to authorize `POST /v1/open` and does not authorize management routes. Static-token requests do not receive named-account quota accounting or request logs; the process-wide browser cap still applies. The supplied Compose file passes only the administrator token and concurrency setting, so adding a legacy token there requires explicitly mapping it into the container environment. New `dlk_` browser keys are created through the administrator routes and can be used alongside that static token.

Configure your calling application with the DeepLook API resource's private Coolify hostname and keep the browser API off the public Internet. If direct external access is deliberately needed, assign a separate domain, terminate TLS at Coolify, and restrict ingress; never expose plain HTTP. Keep `DEEPLOOK_ADMIN_TOKEN` only in Coolify's secret environment settings. Back up the `/app/data` volume; restoring `accounts.json` restores accounts, key hashes, usage, and retained request logs. Browser key plaintext cannot be recovered and is returned only when a key is created or rotated.

For an existing Nymetric integration, use the same private service URL for its `DEEPLOOK_MANAGEMENT_URL`, `DEEPLOOK_GATEWAY_URL`, and `DEEPLOOK_API_URL`. These are Nymetric settings, not settings consumed by this API. Supply the matching administrator token only to the trusted Nymetric backend; if that integration uses legacy browser access, also configure its separate `DEEPLOOK_API_TOKEN`. Set its `DEEPLOOK_ACCOUNT_ID` to the account identifier you create. A general integration only needs its own named browser key for page opens.

The API does not send email and needs no SMTP credentials. If your application sends email, use your own provider in that application; see [optional email integration](credentials.md#optional-email-integration).

## Smoke check

After deployment, use the [account and browser-key walkthrough](credentials.md#create-your-first-account-and-key) with `DEEPLOOK_URL` set to the service's reachable private URL. Run the requests from a trusted backend or host that can reach that network. Keep the administrator token out of your browser frontend.

1. `GET /health` should return `{ "ok": true }`; this checks process liveness only.
2. Ensure your account with the administrator token, then create a named browser key.
3. Save the returned `secret` in the calling application and use it for `POST /v1/open` with `https://example.com`.
4. Check the account usage endpoint for attribution and inspect any browser error before exposing traffic.

A health check alone does not validate Chromium's sandbox or a real page navigation. Browser key plaintext is returned once on creation/rotation; token-list responses contain metadata only. Bot checks are errors and captchas are not solved.
