# The API: one Node function behind a function URL, reached through the app distribution only.
#
# The function URL is public (auth NONE), as an ALB would be. The app refuses any request without the
# X-Origin-Verify header CloudFront adds (the origin-verify-secret parameter). Signing with CloudFront
# OAC for Lambda instead would make every client hash request bodies (x-amz-content-sha256), which
# browsers and the CLI do not do.

# Until the first deploy: a function that answers 503. The deploy workflow replaces the code
# (aws lambda update-function-code), and Terraform ignores it from then on.
data "archive_file" "placeholder" {
  type        = "zip"
  output_path = "${path.root}/.terraform/tmp/${local.name}-placeholder.zip"

  source {
    filename = "index.js"
    content  = <<-EOT
      exports.handler = async () => ({
        statusCode: 503,
        headers: { "content-type": "text/plain" },
        body: "Not deployed yet.\n",
      });
    EOT
  }
}

# The function's environment: the deployment plumbing, from the module's inputs. The instance's own
# values (ALLOWED_EMAIL_DOMAINS, OIDC_*, INSTANCE_NAME, BRAND_*) usually travel in the deploy
# config's INSTANCE object instead (var.instance), so changing them needs no infrastructure change;
# var.environment can still set or override any key here except the four the module owns. LIVE_URL
# is the live rooms' WebSocket stage (live.tf); the instance turns them off with LIVE=false. MAIL_*
# and SES_CONFIGURATION_SET come from var.mail (mail.tf), and only with it.
locals {
  environment = merge(
    {
      APP_ENV            = "production"
      APP_ORIGIN         = local.url
      SITES_DOMAIN       = var.hostname
      SITE_SCHEME        = "https"
      SITE_COOKIE_DOMAIN = ".${var.hostname}"
      STORE_DRIVER       = "dynamo"
      STORAGE_DRIVER     = "s3"
      KVS_DRIVER         = "cloudfront"
      LIVE_URL           = local.live_url
      NODE_OPTIONS       = "--enable-source-maps"
    },
    var.environment,
    {
      TABLE_NAME   = aws_dynamodb_table.this.name
      SITES_BUCKET = aws_s3_bucket.sites.bucket
      KVS_ARN      = aws_cloudfront_key_value_store.sites.arn
      SSM_PREFIX   = local.ssm_prefix
    },
    local.mail_environment,
  )
}

resource "aws_lambda_function" "api" {
  function_name = "${local.name}-api"
  description   = "${var.name} (${var.env}) API. Code deployed by ${var.github.owner}/${var.github.repo}."
  role          = aws_iam_role.api.arn

  runtime       = var.lambda.runtime
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = var.lambda.memory_size
  timeout       = var.lambda.timeout

  filename         = data.archive_file.placeholder.output_path
  source_code_hash = data.archive_file.placeholder.output_base64sha256

  environment {
    variables = local.environment
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.this.name
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  depends_on = [aws_iam_role_policy.api]
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
}

# A public function URL needs both statements since October 2025: InvokeFunctionUrl, and
# InvokeFunction restricted to calls that come through the URL.
resource "aws_lambda_permission" "url" {
  statement_id           = "FunctionURLAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "url_invoke" {
  statement_id             = "FunctionURLAllowInvokeAction"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.api.function_name
  principal                = "*"
  invoked_via_function_url = true
}
