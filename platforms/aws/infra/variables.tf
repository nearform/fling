variable "namespace" {
  description = <<-EOT
    Prefix of every resource name: <namespace>-<env>-<name> (e.g. acme-production-fling-api), and of
    the log group and SSM parameters: /<namespace>/<env>/<name>/. Your organisation or platform name.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*$", var.namespace))
    error_message = "namespace: lowercase letters, digits and hyphens."
  }
}

variable "env" {
  description = "Environment, for example production. Part of every resource name."
  type        = string
}

variable "name" {
  description = "The app's name in resource names (<namespace>-<env>-<name>) and descriptions."
  type        = string
  default     = "fling"
}

variable "bucket_prefix" {
  description = <<-EOT
    Prepended to the two S3 bucket names (<bucket_prefix><namespace>-<env>-<name>-ui and -sites),
    which must be unique across all of AWS. For example "acme-", or "" for none.
  EOT
  type        = string
  default     = ""
}

variable "hostname" {
  description = <<-EOT
    The app's hostname, for example fling.example.test. The UI and API are served there, and every
    site on a subdomain of it (*.<hostname>). Must be in the zone given by zone_id.
  EOT
  type        = string
}

variable "zone_id" {
  description = "Route 53 hosted zone the hostname, the wildcard and the certificate validation record go in."
  type        = string
}

variable "github" {
  description = <<-EOT
    The repository whose deploy workflow ships Fling (the upstream repository, or your fork). Trust is
    on GitHub's immutable OIDC subject, so owner_id and repo_id are the numeric ids
    (gh api repos/<owner>/<repo> --jq '.owner.id, .id'). Only jobs in the named GitHub environment
    can deploy.
  EOT
  type = object({
    owner       = string
    owner_id    = string
    repo        = string
    repo_id     = string
    environment = optional(string, "production")
  })
}

variable "github_oidc_provider_arn" {
  description = <<-EOT
    ARN of the account's IAM OIDC provider for https://token.actions.githubusercontent.com (audience
    sts.amazonaws.com). An account has at most one, so this module never creates it. null: look it up.
  EOT
  type        = string
  default     = null
}

variable "environment" {
  description = <<-EOT
    Extra or overriding environment variables for the function. The module already sets APP_ENV,
    APP_ORIGIN, SITES_DOMAIN, SITE_SCHEME, SITE_COOKIE_DOMAIN, the drivers and NODE_OPTIONS (from the
    hostname) and LIVE_URL (the live rooms' stage, live.tf), and always sets TABLE_NAME, SITES_BUCKET, KVS_ARN and SSM_PREFIX. Not secret: they are
    in the function's configuration. Instance values belong in var.instance instead.
  EOT
  type        = map(string)
  default     = {}
}

variable "instance" {
  description = <<-EOT
    The instance's own values (ALLOWED_EMAIL_DOMAINS and/or ALLOWED_EMAILS, OIDC_ISSUER,
    OIDC_CLIENT_ID, INSTANCE_NAME, BRAND_*...; see platforms/aws/DEPLOY.md, Instance configuration),
    passed through as INSTANCE in the deploy output. The deploy workflow writes them into the
    function's bundle, so they need no apply to reach it, only a redeploy. Empty: the deploy output has no INSTANCE (add it yourself).
  EOT
  type        = map(string)
  default     = {}
}

variable "lambda" {
  description = "The API function's runtime and size."
  type = object({
    runtime     = optional(string, "nodejs24.x")
    memory_size = optional(number, 512)
    timeout     = optional(number, 30)
  })
  default = {}
}

variable "api_paths" {
  description = "Path patterns on the app hostname that go to the API function, uncached. Everything else is the UI."
  type        = list(string)
  # /mcp, /oauth/* and /.well-known/* are the remote MCP connector, its OAuth server and the
  # instance metadata (/.well-known/fling).
  default = ["/api/*", "/auth/*", "/healthz", "/mcp", "/mcp/*", "/oauth/*", "/.well-known/*"]
}

variable "generated_secrets" {
  description = <<-EOT
    SSM SecureString parameters under the prefix whose values Terraform generates (40 random
    characters). Generated in memory and written with a write-only attribute, so never in state.
  EOT
  type        = list(string)
  default     = ["session-secret", "site-hmac-key"]
}

variable "manual_secrets" {
  description = <<-EOT
    SSM SecureString parameters under the prefix that someone fills by hand or by script
    (aws ssm put-parameter --overwrite). Terraform creates them with the value "unset" and never looks
    at the value again. oidc-client-secret is the sign-in client's secret.
  EOT
  type        = list(string)
  default     = ["oidc-client-secret"]
}

variable "secrets_version" {
  description = <<-EOT
    Bump to regenerate every generated secret and the X-Origin-Verify header. Running functions keep
    the old values until their next cold start: redeploy the function afterwards.
  EOT
  type        = number
  default     = 1
}

variable "enable_data_migrations" {
  description = <<-EOT
    Grant what the deploy's data-migration step needs: lambda:InvokeFunction on the function for the
    deploy role, and dynamodb:Scan on the table for the function's role. Without them deploys warn
    and leave migrations pending.
  EOT
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "How long the function's logs are kept."
  type        = number
  default     = 30
}

variable "price_class" {
  description = "CloudFront price class of both distributions. PriceClass_100: Europe and North America edges, the cheapest."
  type        = string
  default     = "PriceClass_100"
}

variable "error_page_path" {
  description = <<-EOT
    The sites distribution's error page, a key in the sites bucket. S3 403s and 404s on any site are
    answered with it and a 404 status. Paths under its directory are served to every site host without
    the site router, so the deploy workflow owns that prefix.
  EOT
  type        = string
  default     = "/_fling/404.html"
}
