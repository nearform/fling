# var.mail (mail.tf), planned against mocked providers: no AWS account or credentials needed
# (scripts/check-terraform.mjs runs it in the gate). Without mail nothing of mail.tf exists and the
# function's environment carries no mail settings; with it, the grant, the environment and the
# every-minute schedule, and /notifications/* among the app distribution's API behaviours.

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

run "without_mail" {
  command = plan

  assert {
    condition = (
      length(aws_scheduler_schedule.notify) == 0 &&
      length(aws_iam_role.notify) == 0 &&
      length(aws_iam_role_policy.mail) == 0
    )
    error_message = "Without mail, mail.tf must create nothing."
  }

  assert {
    condition     = length([for k in keys(local.environment) : k if startswith(k, "MAIL_") || startswith(k, "SES_")]) == 0
    error_message = "Without mail, the function gets no mail settings."
  }

  assert {
    condition = jsonencode([
      for b in aws_cloudfront_distribution.app.ordered_cache_behavior : b.path_pattern if b.target_origin_id == "api"
    ]) == jsonencode(["/api/*", "/auth/*", "/healthz", "/mcp", "/mcp/*", "/oauth/*", "/.well-known/*"])
    error_message = "Without mail, the API behaviours are var.api_paths' default, unchanged."
  }
}

run "with_mail" {
  command = plan

  variables {
    mail = {
      from                   = "Fling@mail.fling.example.test"
      identity_arn           = "arn:aws:ses:eu-west-1:123456789012:identity/mail.fling.example.test"
      configuration_set_name = "fling-mail"
    }
  }

  assert {
    condition = (
      jsonencode(sort(data.aws_iam_policy_document.mail[0].statement[0].actions)) == jsonencode(["ses:SendEmail"]) &&
      jsonencode(sort(data.aws_iam_policy_document.mail[0].statement[0].resources)) == jsonencode([
        "arn:aws:ses:eu-west-1:123456789012:configuration-set/fling-mail",
        "arn:aws:ses:eu-west-1:123456789012:identity/mail.fling.example.test",
      ]) &&
      one(data.aws_iam_policy_document.mail[0].statement[0].condition).test == "StringEquals" &&
      one(data.aws_iam_policy_document.mail[0].statement[0].condition).variable == "ses:FromAddress" &&
      jsonencode(sort(one(data.aws_iam_policy_document.mail[0].statement[0].condition).values)) == jsonencode(["fling@mail.fling.example.test"])
    )
    error_message = "The function may send from mail.from only, on the identity and the configuration set."
  }

  assert {
    condition = (
      local.environment.MAIL_DRIVER == "ses" &&
      local.environment.MAIL_FROM == "fling@mail.fling.example.test" &&
      local.environment.SES_CONFIGURATION_SET == "fling-mail" &&
      !contains(keys(local.environment), "MAIL_REPLY_TO") &&
      !contains(keys(local.environment), "MAIL_FROM_NAME")
    )
    error_message = "The function's mail settings: ${jsonencode(local.environment)}"
  }

  assert {
    condition = (
      aws_scheduler_schedule.notify[0].schedule_expression == "rate(1 minute)" &&
      aws_scheduler_schedule.notify[0].target[0].input == jsonencode({ fling = "notify" })
    )
    error_message = "The schedule invokes the function with {\"fling\":\"notify\"} every minute."
  }

  assert {
    condition = contains([
      for b in aws_cloudfront_distribution.app.ordered_cache_behavior : b.path_pattern if b.target_origin_id == "api"
    ], "/notifications/*")
    error_message = "With mail, the unsubscribe page (/notifications/*) goes to the API."
  }
}

run "with_mail_and_custom_api_paths" {
  command = plan

  variables {
    api_paths = ["/api/*", "/auth/*"]
    mail = {
      from         = "fling@mail.fling.example.test"
      identity_arn = "arn:aws:ses:eu-west-1:123456789012:identity/mail.fling.example.test"
    }
  }

  assert {
    condition = jsonencode([
      for b in aws_cloudfront_distribution.app.ordered_cache_behavior : b.path_pattern if b.target_origin_id == "api"
    ]) == jsonencode(["/api/*", "/auth/*", "/notifications/*"])
    error_message = "With mail, /notifications/* is added to a custom api_paths too."
  }
}

run "refuses_mail_settings_in_environment" {
  command = plan

  variables {
    environment = { MAIL_DRIVER = "ses" }
  }

  expect_failures = [var.environment]
}

run "refuses_mail_settings_in_instance" {
  command = plan

  variables {
    instance = { SES_CONFIGURATION_SET = "fling-mail" }
  }

  expect_failures = [var.instance]
}

run "without_configuration_set" {
  command = plan

  variables {
    mail = {
      from         = "fling@mail.fling.example.test"
      identity_arn = "arn:aws:ses:eu-west-1:123456789012:identity/mail.fling.example.test"
    }
  }

  assert {
    condition = (
      jsonencode(sort(data.aws_iam_policy_document.mail[0].statement[0].resources)) ==
      jsonencode(["arn:aws:ses:eu-west-1:123456789012:identity/mail.fling.example.test"]) &&
      !contains(keys(local.environment), "SES_CONFIGURATION_SET")
    )
    error_message = "Without a configuration set, the grant is on the identity only."
  }
}

run "refuses_a_malformed_identity" {
  command = plan

  variables {
    mail = {
      from         = "fling@mail.fling.example.test"
      identity_arn = "mail.fling.example.test"
    }
  }

  expect_failures = [var.mail]
}
