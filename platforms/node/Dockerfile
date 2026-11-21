# syntax=docker/dockerfile:1
#
# The Node host image: a whole Fling in one container (platforms/node/src/main.ts, bundled by
# scripts/build.mjs), with the web UI, the sites' own pages and the Claude Desktop extension built
# in. Every value comes from the environment at run time (platforms/node/README.md), so one image
# serves every instance. Build it from the repository root:
#
#   docker build -f platforms/node/Dockerfile -t fling-node .
#
# Build arguments:
# - FLING_ENTRY: the entry point to bundle (default the Node host's own). Another platform on Node
#   (GCP, Azure) names its own entry, which imports this package's host and adapters, and reuses
#   the rest of this file.
# - FLING_MCPB_SERVER_URL: the app origin baked into the extension the UI offers, so it adds this
#   instance when installed. Empty (the default), the extension asks for a server.
#
# The runtime stage is the bundle, its one installed dependency (PGlite) and the web build, run as
# the unprivileged `node` user, with a healthcheck on /healthz.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /src
# The store first, from the lockfile alone, so a source change keeps this layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile \
      --filter "@fling/platform-node..." --filter "@fling/web..." --filter "./apps/cli..."
ARG FLING_ENTRY=platforms/node/src/main.ts
ARG FLING_MCPB_SERVER_URL=
RUN pnpm --filter "@fling/web..." build \
 && FLING_MCPB_SERVER_URL="$FLING_MCPB_SERVER_URL" pnpm --dir apps/cli run build:mcpb \
 && node platforms/node/scripts/build.mjs --entry "$FLING_ENTRY" --outdir /out/dist/server \
 && mkdir -p /out/web/dist/downloads \
 && cp -r apps/web/dist apps/web/dist-404 apps/web/dist-review apps/web/sites-robots.txt /out/web/ \
 && cp apps/cli/dist/fling.mcpb /out/web/dist/downloads/fling.mcpb \
 && cp -r platforms/node/drizzle /out/drizzle

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app/dist/server
COPY --from=build /out/dist/server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production \
    APP_ENV=production \
    PORT=8080 \
    WEB_DIR=/app/web \
    FS_ROOT=/data
WORKDIR /app
COPY --from=build /out/ /app/
COPY --from=deps /app/dist/server/node_modules /app/dist/server/node_modules
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "/app/dist/server/main.mjs"]
