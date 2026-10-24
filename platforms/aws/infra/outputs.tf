output "url" {
  description = "Where the app is served."
  value       = local.url
}

output "deploy" {
  description = <<-EOT
    What the deploy workflow needs, set as ONE repository variable, AWS_DEPLOY_CONFIG, holding this
    map as JSON: terraform output -json deploy | gh variable set AWS_DEPLOY_CONFIG -R <owner>/<repo>.
    Includes INSTANCE when var.instance is set. Nothing here is secret.
  EOT
  value = merge(
    {
      AWS_REGION            = local.region
      AWS_DEPLOY_ROLE_ARN   = aws_iam_role.deploy.arn
      LAMBDA_FUNCTION       = aws_lambda_function.api.function_name
      UI_BUCKET             = aws_s3_bucket.ui.bucket
      SITES_BUCKET          = aws_s3_bucket.sites.bucket
      SITE_ROUTER_FUNCTION  = aws_cloudfront_function.site_router.name
      APP_DISTRIBUTION_ID   = aws_cloudfront_distribution.app.id
      SITES_DISTRIBUTION_ID = aws_cloudfront_distribution.sites.id
      APP_ORIGIN            = local.url
    },
    # Only when set, so an empty var.instance leaves the output as it was.
    { for k, v in { INSTANCE = var.instance } : k => v if length(v) > 0 },
  )
}

output "ssm_prefix" {
  description = "Where the app's secrets are (SSM SecureString parameters)."
  value       = local.ssm_prefix
}

output "manual_secrets" {
  description = "Parameters that someone has to fill (aws ssm put-parameter --overwrite)."
  value       = [for p in aws_ssm_parameter.manual : p.name]
}

output "table_name" {
  description = "DynamoDB table."
  value       = aws_dynamodb_table.this.name
}

output "key_value_store_arn" {
  description = "The site router's KeyValueStore."
  value       = aws_cloudfront_key_value_store.sites.arn
}

output "log_group" {
  description = "The function's logs."
  value       = aws_cloudwatch_log_group.this.name
}

output "function_name" {
  description = "The API's Lambda function (for running migrations by hand: platforms/aws/DEPLOY.md)."
  value       = aws_lambda_function.api.function_name
}
