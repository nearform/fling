# Fling on AWS, with near-zero idle cost: no VPC, no ALB, no database server. Everything is paid per
# request, plus S3 storage. See ../DEPLOY.md.
#
#   <hostname>    CloudFront "app" ─┬─ api_paths → Lambda function URL (Node, X-Origin-Verify header)
#                                   └─ default   → ui bucket (the SPA, OAC)
#   *.<hostname>  CloudFront "sites" ── viewer-request CloudFront Function + KeyValueStore
#                                   └─ sites bucket (OAC)
#   DynamoDB (one table, on demand), SSM SecureString parameters for secrets.
#
# Who changes what:
# - Terraform owns the shape: buckets, table, function configuration and environment, distributions,
#   roles, DNS, and which secrets exist.
# - The repository's deploy workflow (.github/workflows/deploy.yml) owns the code: the function's
#   zip, the UI files, the error page and the site router's code. Terraform starts each with a
#   placeholder and ignores it from then on, so a plan after a deploy reads "No changes".
# - The app owns the KeyValueStore's keys and the table's items.
#
# Resource names are <namespace>-<env>-<name> (e.g. acme-production-fling); the log group and the
# SSM parameters live under /<namespace>/<env>/<name>.

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  name       = "${var.namespace}-${var.env}-${var.name}"
  url        = "https://${var.hostname}"
  ssm_prefix = "/${var.namespace}/${var.env}/${var.name}/"

  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/${var.namespace}/${var.env}/${var.name}"
  retention_in_days = var.log_retention_days
}

# -----------------------------------------------------------------------------
# The app's data: one table, single-table design, keys PK and SK.
# -----------------------------------------------------------------------------

resource "aws_dynamodb_table" "this" {
  name                        = local.name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "PK"
  range_key                   = "SK"
  deletion_protection_enabled = true

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  # Short-lived items (OAuth codes, pending authorizations, staged uploads) carry an epoch-seconds
  # `ttl`. Expiry is also enforced in code; TTL only cleans up.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  # Encrypted at rest with the AWS owned key (no server_side_encryption block), at no cost. Point in
  # time recovery is also what a data migration is rehearsed on (../DEPLOY.md).
  point_in_time_recovery {
    enabled = true
  }
}
