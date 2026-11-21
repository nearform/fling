# The Azure platform's image: the Container App and its jobs (platforms/azure/src/main.ts).
# Built from the repository root after `pnpm build` (deploy-azure.yml), which leaves the bundle in
# platforms/azure/dist (main.mjs, and instance.json from FLING_INSTANCE_CONFIG) and the web build
# in apps/web. Nothing is installed: the bundle carries its dependencies.
#
#   docker build -f platforms/azure/Dockerfile -t <registry>/fling:<tag> .
#
# The default command serves HTTP on 8080; the jobs run `node main.mjs tick notify`,
# `node main.mjs tick maintain` and `node main.mjs migrate` (infra/api.tf).
FROM node:24-slim

ENV NODE_ENV=production PORT=8080
WORKDIR /app

COPY platforms/azure/dist/ ./
COPY apps/web/dist/ ./web/dist/
COPY apps/web/dist-404/ ./web/dist-404/
COPY apps/web/dist-review/ ./web/dist-review/
COPY apps/web/sites-robots.txt ./web/sites-robots.txt

USER node
EXPOSE 8080
CMD ["node", "main.mjs"]
