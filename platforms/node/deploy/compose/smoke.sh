#!/usr/bin/env bash
# The e2e scenario against the compose file on this machine: builds the image, brings up the Node
# host, Postgres, MinIO and Caddy under compose.local.yaml (HTTP on lvh.me, dev login), runs
# `pnpm e2e attached` against it, and takes everything down again, volumes included. Needs Docker
# and the repository built (`pnpm build`, for the CLI the scenario drives).
#
#   platforms/node/deploy/compose/smoke.sh          (FLING_LOCAL_PORT=47380 by default)
#   FLING_SMOKE_KEEP=1 …                            leave it running afterwards
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
port="${FLING_LOCAL_PORT:-47380}"
if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
  echo "smoke: port $port is in use; set FLING_LOCAL_PORT to a free one" >&2
  exit 1
fi
envfile="$(mktemp)"
secret() { node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"; }
cat > "$envfile" <<ENV
FLING_LOCAL_PORT=$port
FLING_APP_HOST=fling.lvh.me
FLING_SITES_DOMAIN=fling.lvh.me
FLING_STORAGE_HOST=storage.lvh.me
SESSION_SECRET=$(secret)
SITE_HMAC_KEY=$(secret)
POSTGRES_PASSWORD=$(secret)
MINIO_ROOT_PASSWORD=$(secret)
S3_SECRET_ACCESS_KEY=$(secret)
ENV
compose=(docker compose -p fling-smoke -f "$here/compose.yaml" -f "$here/compose.local.yaml"
  --env-file "$envfile")
down() {
  if [[ -z "${FLING_SMOKE_KEEP:-}" ]]; then "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; fi
  rm -f "$envfile"
}
trap down EXIT
"${compose[@]}" up -d --build --wait
FLING_E2E_ORIGIN="http://fling.lvh.me:$port" pnpm --dir "$repo" --filter @fling/e2e e2e attached
