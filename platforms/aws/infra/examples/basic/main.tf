# A minimal root module deploying one Fling instance with platforms/aws/infra, at
# https://fling.example.test with sites at https://<name>.fling.example.test. Copy it into your own
# Terraform repository and replace every example value. See platforms/aws/DEPLOY.md.

terraform {
  # Write-only attributes (the generated secrets never reach state) need 1.11.
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  # Keep state somewhere durable and shared, for example:
  # backend "s3" {
  #   bucket       = "example-terraform-state"
  #   key          = "fling/terraform.tfstate"
  #   region       = "eu-west-1"
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = "eu-west-1"

  default_tags {
    tags = { App = "fling" }
  }
}

# CloudFront only takes certificates from us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = { App = "fling" }
  }
}

# A hosted zone you already have. The module adds fling.example.test, *.fling.example.test and the
# certificate's validation record to it.
data "aws_route53_zone" "this" {
  name = "example.test"
}

module "fling" {
  # From your own configuration, pin a release of the Fling repository (or your fork):
  #   source = "git::https://github.com/<owner>/fling.git//platforms/aws/infra?ref=<tag>"
  source = "../.."

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  namespace     = "example"       # resources: example-production-fling-*
  env           = "production"    # SSM and logs: /example/production/fling/
  bucket_prefix = "example-test-" # S3 bucket names are global
  hostname      = "fling.${data.aws_route53_zone.this.name}"
  zone_id       = data.aws_route53_zone.this.zone_id

  # The repository that deploys (gh api repos/<owner>/<repo> --jq '.owner.id, .id').
  github = {
    owner    = "example-org"
    owner_id = "1000001"
    repo     = "fling"
    repo_id  = "2000002"
  }

  # Becomes INSTANCE in the deploy output (platforms/aws/DEPLOY.md, Instance configuration).
  instance = {
    ALLOWED_EMAIL_DOMAINS = "example.test"
    OIDC_ISSUER           = "https://accounts.google.com"
    OIDC_CLIENT_ID        = "1234-abcd.apps.googleusercontent.com"
    INSTANCE_NAME         = "Example Fling"
  }

  # Email notifications, through an SES identity you already have in this region
  # (platforms/aws/DEPLOY.md, Email). Without it there is no email.
  # mail = {
  #   from         = "fling@mail.fling.example.test"
  #   identity_arn = "arn:aws:ses:eu-west-1:123456789012:identity/mail.fling.example.test"
  # }
}

# Creating a public function URL can make AWS add the FunctionURLAllowPublicAccess permission
# itself, and the first apply then fails on the module's copy of it ("ResourceConflictException:
# The statement id (FunctionURLAllowPublicAccess) provided already exists"). If yours does,
# uncomment this and apply again; once it is in state the block is a no-op.
# import {
#   to = module.fling.aws_lambda_permission.url
#   id = "example-production-fling-api/FunctionURLAllowPublicAccess"
# }

output "url" {
  value = module.fling.url
}

output "deploy" {
  description = "The repository variable AWS_DEPLOY_CONFIG, as JSON."
  value       = module.fling.deploy
}

output "manual_secrets" {
  description = "SSM parameters to fill by hand (aws ssm put-parameter --overwrite)."
  value       = module.fling.manual_secrets
}
