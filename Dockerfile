# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS browser-build
WORKDIR /build/deeplook
COPY vendor/deeplook/package.json vendor/deeplook/package-lock.json ./
RUN npm ci
COPY vendor/deeplook/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS api-build
WORKDIR /build/api
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium chromium-sandbox ca-certificates tini fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin deeplook

WORKDIR /app
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY --from=api-build --chown=deeplook:deeplook /build/api/dist ./dist
COPY --from=browser-build --chown=deeplook:deeplook /build/deeplook/dist ./vendor/deeplook/dist
COPY --from=browser-build --chown=deeplook:deeplook /build/deeplook/node_modules ./vendor/deeplook/node_modules
COPY --from=browser-build --chown=deeplook:deeplook /build/deeplook/package.json ./vendor/deeplook/package.json
RUN install -d -o deeplook -g deeplook -m 0700 /app/data

ENV NODE_ENV=production \
    DEEPLOOK_HOST=0.0.0.0 \
    DEEPLOOK_PORT=47231 \
    DEEPLOOK_MAX_CONCURRENT=2 \
    DEEPLOOK_DATA_DIR=/app/data \
    DEEPLOOK_CLI_PATH=/app/vendor/deeplook/dist/cli.js \
    DEEPLOOK_CHROME=/usr/bin/chromium

VOLUME ["/app/data"]
EXPOSE 47231
USER deeplook
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:47231/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/serve.js"]
