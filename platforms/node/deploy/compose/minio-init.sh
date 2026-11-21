#!/bin/bash
# MinIO's side of the compose file, safe to run on every start: the private sites bucket, a
# lifecycle rule for chunked MCP uploads (uploads/, kept at most an hour; leftovers swept after a
# day), and the key the Node host uses (`fling`, read and write on that bucket only). Staged
# uploads (sites/<id>/_staged/) are swept by the host's hourly maintenance.
set -euo pipefail
mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing "local/$FLING_BUCKET"
mc anonymous set none "local/$FLING_BUCKET"
cat > /tmp/lifecycle.json <<JSON
{"Rules":[{"ID":"expire-staged-uploads","Status":"Enabled","Filter":{"Prefix":"uploads/"},"Expiration":{"Days":1}}]}
JSON
mc ilm rule import "local/$FLING_BUCKET" < /tmp/lifecycle.json
cat > /tmp/policy.json <<JSON
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["s3:ListBucket"],"Resource":["arn:aws:s3:::$FLING_BUCKET"]},
  {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],"Resource":["arn:aws:s3:::$FLING_BUCKET/*"]}
]}
JSON
mc admin policy create local fling-sites /tmp/policy.json
mc admin user add local fling "$S3_SECRET_ACCESS_KEY"
mc admin policy attach local fling-sites --user fling >/dev/null 2>&1 || true
echo "minio-init: bucket $FLING_BUCKET ready"
