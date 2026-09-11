# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Local LLM Gateway — multi-stage image
#
# The gateway requires Node.js >= 22.13 because it uses the built-in `node:sqlite`
# module (DatabaseSync) unflagged. On Node 22.5-22.12 that module still needed
# `--experimental-sqlite`; Node 24 is used here and is the recommended runtime.
# The `slim` (Debian) variants are used rather than `alpine` because node:sqlite
# relies on a SQLite build that is best supported by the official Debian-based images.
# ---------------------------------------------------------------------------

# --------------------------------------------------------------- build stage
FROM node:24-slim AS build

WORKDIR /app

# Keep npm quiet and deterministic in CI.
ENV npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false

# Dependency manifests first so the dependency layer is cached across source edits.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# The dashboard is a separate Vite app. Older checkouts may not include it, so the
# build is conditional: the gateway serves `web/dist` when present and returns a
# clear "not built" message otherwise.
COPY web/package.json web/package-lock.json* ./web/
RUN if [ -f web/package.json ]; then \
      cd web && \
      if [ -f package-lock.json ]; then npm ci; else npm install; fi; \
    fi

COPY tsconfig.json ./
COPY src ./src
COPY web ./web

RUN npm run build
RUN if [ -f web/package.json ]; then npm run build:web; fi

# Drop development dependencies so only production packages are copied forward.
RUN npm prune --omit=dev

# ------------------------------------------------------------- runtime stage
FROM node:24-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    LOCAL_GATEWAY_HOST=0.0.0.0 \
    LOCAL_GATEWAY_PORT=8317 \
    LOCAL_GATEWAY_DB_PATH=/app/data/gateway.db

LABEL org.opencontainers.image.title="Local LLM Gateway" \
      org.opencontainers.image.description="Self-hosted multi-model LLM API gateway with protocol compatibility, API key pool, usage accounting and observability dashboard." \
      org.opencontainers.image.source="https://github.com/local/local-llm-gateway" \
      org.opencontainers.image.licenses="MIT"

# `node` already exists in the official image (uid 1000) and is unprivileged.
# The data directory holds the SQLite database (WAL mode adds -wal/-shm files)
# and the auto-generated master key, so it must be writable by that user.
RUN mkdir -p /app/data && chown -R node:node /app/data

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# The dashboard build is optional; copy it only if it was produced.
COPY --from=build --chown=node:node /app/web/dist ./web/dist

USER node

EXPOSE 8317

# The image is slim, so neither curl nor wget can be assumed. Node is guaranteed
# present, so the probe uses a Node one-liner against the gateway's own /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LOCAL_GATEWAY_PORT||8317)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# JSON-array form: no shell, so signals reach Node directly and SIGTERM triggers
# the gateway's graceful shutdown (WAL checkpoint + connection drain).
CMD ["node", "dist/index.js"]
