# var.paths_per_site, planned against mocked providers (scripts/check-terraform.mjs runs it in the
# gate): the function's PATHS_PER_SITE_MAX, 200 unless set, which neither var.instance nor
# var.environment may set.

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

run "defaults_to_200" {
  command = plan

  assert {
    condition     = aws_lambda_function.api.environment[0].variables.PATHS_PER_SITE_MAX == "200"
    error_message = "Without paths_per_site, the function allows 200 live Paths per site."
  }
}

run "takes_paths_per_site" {
  command = plan

  variables {
    paths_per_site = 50
  }

  assert {
    condition     = aws_lambda_function.api.environment[0].variables.PATHS_PER_SITE_MAX == "50"
    error_message = "paths_per_site becomes the function's PATHS_PER_SITE_MAX."
  }
}

run "refuses_more_than_the_ceiling" {
  command = plan

  variables {
    paths_per_site = 1001
  }

  expect_failures = [var.paths_per_site]
}

run "refuses_it_in_instance" {
  command = plan

  variables {
    instance = { PATHS_PER_SITE_MAX = "1000" }
  }

  expect_failures = [var.instance]
}

run "refuses_it_in_environment" {
  command = plan

  variables {
    environment = { PATHS_PER_SITE_MAX = "1000" }
  }

  expect_failures = [var.environment]
}
