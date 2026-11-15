# var.servers (servers.tf), planned against mocked providers: no AWS account or credentials needed
# (scripts/check-terraform.mjs runs it in the gate). Off, nothing of servers.tf exists and the
# function and the sites distribution are as they were; on, the fence, the role, the zip bucket,
# the /api/* behaviour and the function's plumbing, and with egress "none" the VPC and connector.

mock_provider "aws" {
  mock_data "aws_region" {
    defaults = { region = "eu-west-1" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["eu-west-1a", "eu-west-1b", "eu-west-1c"] }
  }
}

mock_provider "aws" {
  alias           = "us_east_1"
  override_during = plan

  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/example"
      domain_validation_options = [{
        domain_name           = "fling.example.test"
        resource_record_name  = "_example.fling.example.test"
        resource_record_type  = "CNAME"
        resource_record_value = "_example.acm-validations.aws"
      }]
    }
  }

  mock_resource "aws_acm_certificate_validation" {
    defaults = { certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/example" }
  }
}

mock_provider "archive" {}

variables {
  namespace     = "example"
  env           = "production"
  bucket_prefix = "example-test-"
  hostname      = "fling.example.test"
  zone_id       = "Z0000000000000"
  github = {
    owner    = "example-org"
    owner_id = "1000001"
    repo     = "fling"
    repo_id  = "2000002"
  }
  github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
}

run "without_servers" {
  command = plan

  assert {
    condition = (
      length(aws_iam_role.server) == 0 &&
      length(aws_iam_role_policy.servers) == 0 &&
      length(aws_s3_bucket.server_zips) == 0 &&
      length(aws_ssm_parameter.site_secrets_key) == 0 &&
      length(aws_vpc.servers) == 0 &&
      length(aws_lambdacore_network_connector.servers) == 0
    )
    error_message = "Without servers, servers.tf must create nothing."
  }

  assert {
    condition     = length([for k in keys(local.environment) : k if startswith(k, "SERVER")]) == 0
    error_message = "Without servers, the function gets no server settings."
  }

  assert {
    condition     = length([for b in aws_cloudfront_distribution.sites.ordered_cache_behavior : b if b.path_pattern == "/api/*"]) == 0
    error_message = "Without servers, the sites distribution has no /api/* behaviour."
  }

  assert {
    condition     = length(aws_cloudfront_function.server_status) == 0 && !contains(keys(output.deploy), "SERVER_STATUS_FUNCTION")
    error_message = "Without servers, there is no server status function, and the deploy publishes none."
  }

  assert {
    condition     = aws_lambda_function.api.timeout == 30
    error_message = "Without servers, the function's timeout is var.lambda's."
  }
}

run "with_servers_fenced" {
  command = plan

  variables {
    servers = { enabled = true }
  }

  assert {
    condition = (
      length(aws_iam_role.server) == 1 &&
      length(aws_iam_role_policy.servers) == 1 &&
      length(aws_s3_bucket.server_zips) == 1 &&
      aws_s3_bucket_versioning.server_zips[0].versioning_configuration[0].status == "Enabled" &&
      length(aws_ssm_parameter.site_secrets_key) == 1 &&
      length(aws_subnet.servers) == 2 &&
      length(aws_lambdacore_network_connector.servers) == 1
    )
    error_message = "With servers and egress none: the role, the fence, the versioned zip bucket, the key, the VPC and the connector."
  }

  assert {
    condition = alltrue([
      for k in ["SERVER_FUNCTION_PREFIX", "SERVER_INSTANCE", "SERVER_ROLE_ARN", "SERVER_ZIP_BUCKET", "SITES_DISTRIBUTION_ARN", "SERVER_NETWORK_CONNECTOR_ARN"] :
      contains(keys(local.environment), k)
    ])
    error_message = "With servers, the function gets their plumbing."
  }

  assert {
    condition     = local.environment.SERVER_FUNCTION_PREFIX == "example-production-fling-site-" && local.environment.SERVERS_EGRESS == "none"
    error_message = "Function names are <namespace>-<env>-<name>-site-<siteId>, and egress follows var.servers."
  }

  assert {
    condition = one([
      for b in aws_cloudfront_distribution.sites.ordered_cache_behavior : b if b.path_pattern == "/api/*"
    ]).allowed_methods == toset(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"])
    error_message = "With servers, /api/* on the sites distribution takes every method."
  }

  assert {
    condition = length(aws_cloudfront_function.server_status) == 1 && contains([
      for f in one([
        for b in aws_cloudfront_distribution.sites.ordered_cache_behavior : b if b.path_pattern == "/api/*"
      ]).function_association : f.event_type
    ], "viewer-response") && output.deploy.SERVER_STATUS_FUNCTION == "example-production-fling-server-status"
    error_message = "With servers, /api/* restores a server's 403 and 404 (viewer-response), and the deploy publishes it."
  }

  assert {
    condition = alltrue([
      for b in aws_cloudfront_distribution.sites.ordered_cache_behavior : alltrue([
        for f in b.function_association : f.event_type == "viewer-request"
      ]) if b.path_pattern != "/api/*"
    ]) && alltrue([for f in aws_cloudfront_distribution.sites.default_cache_behavior[0].function_association : f.event_type == "viewer-request"])
    error_message = "Only /api/* has the server status function."
  }

  assert {
    condition     = aws_lambda_function.api.timeout == 60
    error_message = "With servers, the function waits long enough for a start probe."
  }
}

run "with_servers_open" {
  command = plan

  variables {
    servers = { enabled = true, egress = "open" }
  }

  assert {
    condition     = length(aws_vpc.servers) == 0 && length(aws_lambdacore_network_connector.servers) == 0
    error_message = "With egress open there is no VPC and no connector."
  }

  assert {
    condition     = !contains(keys(local.environment), "SERVER_NETWORK_CONNECTOR_ARN") && local.environment.SERVERS_EGRESS == "open"
    error_message = "With egress open the function names no connector."
  }
}
