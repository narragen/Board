# Multi-stage build: deps → web build (vite) → prod deps → runtime.
# The daemon runs TypeScript directly (bun server/src/main.ts) — no server
# build step; web/dist is the only artifact. No token is baked in: credentials
# are minted inside the running container (docs/deployment.md "Docker").

FROM oven/bun:1-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY patches patches
COPY server/package.json server/
COPY cli/package.json cli/
COPY web/package.json web/
RUN bun install --frozen-lockfile

FROM deps AS web-build
COPY web web
RUN cd web && bun run build

FROM oven/bun:1-slim AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY patches patches
COPY server/package.json server/
COPY cli/package.json cli/
COPY web/package.json web/
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-slim AS runtime
WORKDIR /app
# resolveRepoRoot() walks up from server/src looking for package.json + Makefile
# to locate the repo root (web/dist + server/libs hang off it) — both must exist.
COPY package.json Makefile ./
COPY --from=prod-deps /app/node_modules node_modules
COPY server server
COPY cli cli
COPY --from=web-build /app/web/dist web/dist

ENV BOARD_DATA_DIR=/data
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 7800
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.BOARD_PORT ?? 7800) + '/api/health'); process.exit(r.ok ? 0 : 1)"
CMD ["bun", "server/src/main.ts"]
