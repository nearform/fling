# The Cloud Run image of Fling on Google Cloud: the bundled service (scripts/build.mjs), the Google
# clients it leaves outside the bundle, and the web build the Node host serves (the UI, the sites'
# 404 page and review shell, robots.txt). Built from the repository root after
#   pnpm --filter "@fling/platform-gcp..." build && pnpm --filter "@fling/web..." build
# (deploy-gcp.yml does both):
#   docker build -f platforms/gcp/Dockerfile -t <image> .

# The Google clients, at the versions the bundle was built against (dist/server/package.json).
FROM node:24-slim AS deps
WORKDIR /app
COPY platforms/gcp/dist/server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY platforms/gcp/dist/server/ ./
COPY apps/web/dist ./web/dist
COPY apps/web/dist-404 ./web/dist-404
COPY apps/web/dist-review ./web/dist-review
COPY apps/web/sites-robots.txt ./web/sites-robots.txt
USER node
# Cloud Run sets PORT (8080).
CMD ["node", "index.mjs"]
