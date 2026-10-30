# Two roles:
# - api: what the function's code can do. Its table, the sites bucket (it signs the CLI's uploads),
#   the KeyValueStore the site router reads, its own SSM parameters and the live rooms' WebSocket
#   connections. Nothing else.
# - deploy: what the repository's deploy workflow can do, from GitHub Actions over OIDC.
#
# enable_data_migrations adds what the deploy's migrate step needs: the deploy role may invoke the
# function (with {"fling":"migrate"}; a function URL request is always an HTTP event, so nobody
# else can send that), and the function may scan its table (only migrations scan).

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${local.name}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

data "aws_iam_policy_document" "api" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }

  statement {
    sid = "Table"
    actions = [
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.this.arn, "${aws_dynamodb_table.this.arn}/index/*"]
  }

  dynamic "statement" {
    for_each = var.enable_data_migrations ? [1] : []

    content {
      sid       = "TableScanForMigrations"
      actions   = ["dynamodb:Scan"]
      resources = [aws_dynamodb_table.this.arn]
    }
  }

  # Presigned PUTs are signed with this role, so it needs PutObject itself. GetObject covers HEAD.
  # CopyObject (a path publish carrying files forward) needs GetObject on the source and PutObject
  # on the destination, both in this bucket.
  statement {
    sid       = "SitesList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.sites.arn]
  }

  statement {
    sid       = "SitesObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.sites.arn}/*"]
  }

  statement {
    sid = "KeyValueStore"
    actions = [
      "cloudfront-keyvaluestore:DeleteKey",
      "cloudfront-keyvaluestore:DescribeKeyValueStore",
      "cloudfront-keyvaluestore:GetKey",
      "cloudfront-keyvaluestore:ListKeys",
      "cloudfront-keyvaluestore:PutKey",
      "cloudfront-keyvaluestore:UpdateKeys",
    ]
    resources = [aws_cloudfront_key_value_store.sites.arn]
  }

  # The live rooms: post to (and drop) this API's WebSocket connections (live.tf).
  statement {
    sid       = "LiveConnections"
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.live.execution_arn}/${local.live_stage}/*/@connections/*"]
  }

  # GetParametersByPath is authorised on the path itself, GetParameter(s) on each parameter.
  statement {
    sid     = "Secrets"
    actions = ["ssm:GetParametersByPath", "ssm:GetParameter", "ssm:GetParameters"]
    resources = [
      "arn:aws:ssm:${local.region}:${local.account_id}:parameter${trimsuffix(local.ssm_prefix, "/")}",
      "arn:aws:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}*",
    ]
  }

  # The parameters use the AWS managed aws/ssm key. Its key policy already lets the account use it
  # through SSM; this says the same in IAM, limited to SSM in this region.
  statement {
    sid       = "DecryptSecrets"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${local.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "app"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

# -----------------------------------------------------------------------------
# Deploy role, for the app repository's deploy workflow.
# -----------------------------------------------------------------------------

# The account's GitHub Actions OIDC provider (one per account, so not created here): given, or
# looked up by its URL.
data "aws_iam_openid_connect_provider" "github" {
  count = var.github_oidc_provider_arn == null ? 1 : 0

  url = "https://token.actions.githubusercontent.com"
}

locals {
  github_oidc_provider_arn = coalesce(var.github_oidc_provider_arn, one(data.aws_iam_openid_connect_provider.github[*].arn))

  github_subject = "repo:${var.github.owner}@${var.github.owner_id}/${var.github.repo}@${var.github.repo_id}"

  # GitHub environment names are case-insensitive, IAM conditions are not. Accept both spellings.
  github_environments = distinct([var.github.environment, title(var.github.environment)])

  error_page_prefix = trimprefix(dirname(var.error_page_path), "/")
}

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [for e in local.github_environments : "${local.github_subject}:environment:${e}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${local.name}-deploy"
  description          = "Deploy workflow of ${var.github.owner}/${var.github.repo}, ${var.github.environment} environment"
  assume_role_policy   = data.aws_iam_policy_document.deploy_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  # update-function-code, then `aws lambda wait function-updated` (GetFunctionConfiguration).
  statement {
    sid = "FunctionCode"
    actions = [
      "lambda:GetFunction",
      "lambda:GetFunctionConfiguration",
      "lambda:PublishVersion",
      "lambda:UpdateFunctionCode",
    ]
    resources = [aws_lambda_function.api.arn]
  }

  # The migrate step: aws lambda invoke --payload '{"fling":"migrate"}'.
  dynamic "statement" {
    for_each = var.enable_data_migrations ? [1] : []

    content {
      sid       = "RunMigrations"
      actions   = ["lambda:InvokeFunction"]
      resources = [aws_lambda_function.api.arn]
    }
  }

  # The UI: sync, deleting only what the workflow chooses to (never the hashed assets).
  statement {
    sid       = "UiList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.ui.arn]
  }

  statement {
    sid       = "UiObjects"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.ui.arn}/*"]
  }

  # The error page (and anything else under its directory) in the sites bucket. Never the sites.
  statement {
    sid       = "ErrorPageList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.sites.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.error_page_prefix}/*"]
    }
  }

  statement {
    sid       = "ErrorPageObjects"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.sites.arn}/${local.error_page_prefix}/*"]
  }

  # The site router's code. UpdateFunction re-sends the function's KeyValueStore association.
  statement {
    sid = "EdgeFunctions"
    actions = [
      "cloudfront:DescribeFunction",
      "cloudfront:GetFunction",
      "cloudfront:PublishFunction",
      "cloudfront:TestFunction",
      "cloudfront:UpdateFunction",
    ]
    resources = [aws_cloudfront_function.site_router.arn, aws_cloudfront_function.spa.arn]
  }

  statement {
    sid       = "KeyValueStoreAssociation"
    actions   = ["cloudfront:DescribeKeyValueStore"]
    resources = [aws_cloudfront_key_value_store.sites.arn]
  }

  statement {
    sid       = "Invalidate"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = [aws_cloudfront_distribution.app.arn, aws_cloudfront_distribution.sites.arn]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
