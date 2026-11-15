# Site servers (var.servers; DEPLOY.md, Site servers): a site's _fling/server.mjs runs as a Lambda
# Web Function the API creates at publish time, one per site, named <namespace>-<env>-<name>-site-
# <siteId> and tagged fling:instance. Terraform builds only what is shared, and the fence around
# what the API may create:
#
#   - the IAM fence on the API's role: Web Function actions on that name prefix only (creating one
#     needs the instance tag), iam:PassRole on the one server role, the zip bucket, the servers'
#     log groups, and the network connector when egress is fenced;
#   - the server role every revision runs as: it may write its own logs, nothing else;
#   - the zip bucket, versioned: a revision names the object version it was made from and Lambda
#     reads it whenever it starts an environment, so nothing here ever expires an object version
#     (the API deletes them with their revisions);
#   - the site-secrets-key parameter, which seals site secrets (generated once, never rotated by
#     secrets_version: a new key leaves every stored site secret unreadable);
#   - /api/* on the sites distribution: every method, uncached, the viewer's headers but Host. The
#     site router switches a server's requests to the site's `live` endpoint (origin access control
#     signs them; no OAC resource is needed for that), and serves any other site's api/ files from
#     the bucket as before. The response headers policy drops lambda-web-logstream, which names
#     the function and revision;
#   - with egress "none": a VPC with no internet or NAT gateway, and a network connector into it.
#
# The API puts each function's resource policy itself, letting only this sites distribution invoke
# its live endpoint (hence SITES_DISTRIBUTION_ARN).

locals {
  servers_on      = var.servers.enabled
  servers_fenced  = local.servers_on && var.servers.egress == "none"
  server_prefix   = "${local.name}-site-"
  server_fn_arn   = "arn:aws:lambda:${local.region}:${local.account_id}:web-function/${local.server_prefix}*"
  server_logs_arn = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/web/${local.server_prefix}*"

  # Merged into the API function's environment (api.tf). SERVERS_EGRESS follows var.servers.egress
  # so the instance never asks for a fence this deployment lacks.
  servers_environment = local.servers_on ? merge(
    {
      SERVER_FUNCTION_PREFIX = local.server_prefix
      SERVER_INSTANCE        = local.name
      SERVER_ROLE_ARN        = aws_iam_role.server[0].arn
      SERVER_ZIP_BUCKET      = aws_s3_bucket.server_zips[0].bucket
      SITES_DISTRIBUTION_ARN = aws_cloudfront_distribution.sites.arn
      SERVERS_EGRESS         = var.servers.egress
    },
    local.servers_fenced ? {
      SERVER_NETWORK_CONNECTOR_ARN = aws_lambdacore_network_connector.servers[0].latest_version_arn
    } : {},
  ) : {}
}

# -----------------------------------------------------------------------------
# The servers' execution role: its own logs only.
# -----------------------------------------------------------------------------

resource "aws_iam_role" "server" {
  count = local.servers_on ? 1 : 0

  name               = "${local.name}-server"
  description        = "Site servers of ${var.name} (${var.env}): their own logs, nothing else."
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json

  lifecycle {
    precondition {
      # A Web Function's name is at most 64 characters: the prefix and a 12-character site id.
      condition     = length(local.server_prefix) + 12 <= 64
      error_message = "<namespace>-<env>-<name> is too long for site servers' function names: at most 46 characters."
    }
  }
}

data "aws_iam_policy_document" "server" {
  count = local.servers_on ? 1 : 0

  statement {
    sid       = "OwnLogs"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [local.server_logs_arn, "${local.server_logs_arn}:*"]
  }
}

resource "aws_iam_role_policy" "server" {
  count = local.servers_on ? 1 : 0

  name   = "logs"
  role   = aws_iam_role.server[0].id
  policy = data.aws_iam_policy_document.server[0].json
}

# -----------------------------------------------------------------------------
# The fence: what the API's role may do to site servers.
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "servers" {
  count = local.servers_on ? 1 : 0

  # Creating and tagging functions is fenced by name, like every other action here: Web Functions
  # do not evaluate tag conditions (aws:RequestTag, aws:TagKeys) on CreateWebFunction, so a
  # condition on them refuses every create. The name prefix keeps the API to its own instance's
  # functions; the tags it sets are Fling's own (src/servers/naming.ts).
  statement {
    sid       = "CreateAndTagFunctions"
    actions   = ["lambda:CreateWebFunction", "lambda:TagResource"]
    resources = [local.server_fn_arn, "${local.server_fn_arn}/*"]
  }

  statement {
    sid = "ManageFunctions"
    actions = [
      "lambda:CreateWebFunctionEndpoint",
      "lambda:CreateWebFunctionRevision",
      "lambda:DeleteResourcePolicy",
      "lambda:DeleteWebFunction",
      "lambda:DeleteWebFunctionEndpoint",
      "lambda:DeleteWebFunctionRevision",
      "lambda:GetResourcePolicy",
      "lambda:GetWebFunction",
      "lambda:GetWebFunctionEndpoint",
      "lambda:GetWebFunctionRevision",
      "lambda:InvokeWebFunctionEndpoint",
      "lambda:ListTags",
      "lambda:ListWebFunctionEndpoints",
      "lambda:ListWebFunctionRevisions",
      "lambda:PutResourcePolicy",
      "lambda:UntagResource",
      "lambda:UpdateWebFunctionEndpoint",
    ]
    resources = [local.server_fn_arn, "${local.server_fn_arn}/*"]
  }

  statement {
    sid       = "AccountWide"
    actions   = ["lambda:GetWebAccountSettings", "lambda:ListWebFunctions"]
    resources = ["*"]
  }

  statement {
    sid       = "PassServerRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.server[0].arn]
  }

  dynamic "statement" {
    for_each = local.servers_fenced ? [1] : []

    content {
      sid       = "PassNetworkConnector"
      actions   = ["lambda:PassNetworkConnector"]
      resources = ["${aws_lambdacore_network_connector.servers[0].arn}*"]
    }
  }

  statement {
    sid = "Zips"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.server_zips[0].arn}/*"]
  }

  statement {
    sid       = "ZipsList"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
    resources = [aws_s3_bucket.server_zips[0].arn]
  }

  statement {
    sid = "ServerLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:DeleteLogGroup",
      "logs:FilterLogEvents",
      "logs:PutRetentionPolicy",
    ]
    resources = [local.server_logs_arn, "${local.server_logs_arn}:*"]
  }

  statement {
    sid       = "ServerLogGroups"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "servers" {
  count = local.servers_on ? 1 : 0

  name   = "site-servers"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.servers[0].json
}

# -----------------------------------------------------------------------------
# The zip bucket, versioned, read by Lambda for this instance's revisions only.
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "server_zips" {
  count = local.servers_on ? 1 : 0

  bucket = "${var.bucket_prefix}${local.name}-server-zips"
}

resource "aws_s3_bucket_versioning" "server_zips" {
  count = local.servers_on ? 1 : 0

  bucket = aws_s3_bucket.server_zips[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "server_zips" {
  count = local.servers_on ? 1 : 0

  bucket                  = aws_s3_bucket.server_zips[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "server_zips" {
  count = local.servers_on ? 1 : 0

  bucket = aws_s3_bucket.server_zips[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "server_zips" {
  count = local.servers_on ? 1 : 0

  bucket = aws_s3_bucket.server_zips[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "server_zips" {
  count = local.servers_on ? 1 : 0

  # Removing this statement fails every revision for good: Lambda reads the zip at each start.
  statement {
    sid       = "LambdaReadsRevisionZips"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.server_zips[0].arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["${local.server_fn_arn}/revision/*"]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.server_zips[0].arn, "${aws_s3_bucket.server_zips[0].arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "server_zips" {
  count = local.servers_on ? 1 : 0

  bucket = aws_s3_bucket.server_zips[0].id
  policy = data.aws_iam_policy_document.server_zips[0].json

  depends_on = [aws_s3_bucket_public_access_block.server_zips]
}

# -----------------------------------------------------------------------------
# The key site secrets are sealed with (SITE_SECRETS_KEY): 43 random characters, read as base64url,
# are its 32 bytes. Its own version, never secrets_version: a new key strands every stored secret.
# -----------------------------------------------------------------------------

ephemeral "random_password" "site_secrets_key" {
  count = local.servers_on ? 1 : 0

  length  = 43
  special = false
}

resource "aws_ssm_parameter" "site_secrets_key" {
  count = local.servers_on ? 1 : 0

  name        = "${local.ssm_prefix}site-secrets-key"
  description = "${var.name} (${var.env}): seals site secrets. Generated by Terraform (write-only, not in state); never rotate it."
  type        = "SecureString"

  value_wo         = ephemeral.random_password.site_secrets_key[0].result
  value_wo_version = 1
}

# -----------------------------------------------------------------------------
# The sites distribution's /api/* (edge.tf adds the behaviour from these).
# -----------------------------------------------------------------------------

resource "aws_cloudfront_response_headers_policy" "servers" {
  count = local.servers_on ? 1 : 0

  name    = "${local.name}-site-servers"
  comment = "${var.name} (${var.env}): site servers' answers, without the header naming their function and revision."

  remove_headers_config {
    items {
      header = "lambda-web-logstream"
    }
  }
}

# -----------------------------------------------------------------------------
# Egress "none": a VPC with no way out, and the network connector every revision uses.
# -----------------------------------------------------------------------------

data "aws_availability_zones" "servers" {
  count = local.servers_fenced ? 1 : 0

  state = "available"
}

resource "aws_vpc" "servers" {
  count = local.servers_fenced ? 1 : 0

  cidr_block = var.servers.vpc_cidr
  tags       = { Name = "${local.name}-servers" }
}

# No internet gateway, no NAT gateway, no route out: a server's traffic has nowhere to go.
resource "aws_subnet" "servers" {
  count = local.servers_fenced ? 2 : 0

  vpc_id            = aws_vpc.servers[0].id
  availability_zone = data.aws_availability_zones.servers[0].names[count.index]
  cidr_block        = cidrsubnet(var.servers.vpc_cidr, 4, count.index)
  tags              = { Name = "${local.name}-servers-${count.index}" }
}

# No rules: nothing in, nothing out.
resource "aws_security_group" "servers" {
  count = local.servers_fenced ? 1 : 0

  name        = "${local.name}-servers"
  description = "Site servers of ${var.name} (${var.env}): no traffic either way."
  vpc_id      = aws_vpc.servers[0].id
}

# What Lambda uses to place the connector's network interfaces in the subnets.
resource "aws_iam_role" "servers_connector" {
  count = local.servers_fenced ? 1 : 0

  name               = "${local.name}-servers-connector"
  description        = "Places the site servers' network connector in its VPC."
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

data "aws_iam_policy_document" "servers_connector" {
  count = local.servers_fenced ? 1 : 0

  statement {
    sid = "NetworkInterfaces"
    actions = [
      "ec2:CreateNetworkInterface",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSubnets",
      "ec2:DescribeVpcs",
      "ec2:AssignPrivateIpAddresses",
      "ec2:UnassignPrivateIpAddresses",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "servers_connector" {
  count = local.servers_fenced ? 1 : 0

  name   = "network-interfaces"
  role   = aws_iam_role.servers_connector[0].id
  policy = data.aws_iam_policy_document.servers_connector[0].json
}

resource "aws_lambdacore_network_connector" "servers" {
  count = local.servers_fenced ? 1 : 0

  name          = "${local.name}-servers"
  operator_role = aws_iam_role.servers_connector[0].arn

  configuration {
    vpc_egress_configuration {
      subnet_ids                        = aws_subnet.servers[*].id
      security_group_ids                = [aws_security_group.servers[0].id]
      network_protocol                  = "IPv4"
      associated_compute_resource_types = ["WebFunction"]
    }
  }

  # Creating one takes up to ten minutes.
  timeouts {
    create = "20m"
  }

  depends_on = [aws_iam_role_policy.servers_connector]
}
