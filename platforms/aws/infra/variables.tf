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
    APP_ORIGIN, SITES_DOMAIN, SITE_SCHEME, SITE_COOKIE_DOMAIN and the drivers (from the hostname)
    and LIVE_URL (the live rooms' stage, live.tf), and always sets TABLE_NAME, SITES_BUCKET, KVS_ARN
    and SSM_PREFIX. Not secret: they are in the function's configuration. Instance values belong in var.instance instead. MAIL_* and
    SES_CONFIGURATION_SET are refused: email is set in var.mail.
  EOT
  type        = map(string)
  default     = {}

  validation {
    condition     = length([for k in keys(var.environment) : k if can(regex("^(MAIL|SES)_", k))]) == 0
    error_message = "environment may not set MAIL_* or SES_*: email is set in var.mail."
  }
}

variable "instance" {
  description = <<-EOT
    The instance's own values (ALLOWED_EMAIL_DOMAINS and/or ALLOWED_EMAILS, OIDC_ISSUER,
    OIDC_CLIENT_ID, INSTANCE_NAME, BRAND_*...; see platforms/aws/DEPLOY.md, Instance configuration),
    passed through as INSTANCE in the deploy output. The deploy workflow writes them into the
    function's bundle, so they need no apply to reach it, only a redeploy. Empty: the deploy output has no INSTANCE (add it yourself).
    MAIL_* and SES_CONFIGURATION_SET are refused: email is set in var.mail.
  EOT
  type        = map(string)
  default     = {}

  validation {
    condition     = length([for k in keys(var.instance) : k if can(regex("^(MAIL|SES)_", k))]) == 0
    error_message = "instance may not set MAIL_* or SES_*: email is set in var.mail."
  }
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
  # instance metadata (/.well-known/fling). With var.mail, mail.tf adds /notifications/* (the
  # emails' unsubscribe page) to whatever this is.
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
    at the value again. oidc-client-secret is the OIDC_ISSUER client's secret; a Google client's id
    and secret are google-client-id and google-client-secret (either client, or both).
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

variable "mail" {
  description = <<-EOT
    Email, for notifications (mail.tf; DEPLOY.md, Email). null: no email, and none of mail.tf exists.
    Sends through an SES v2 identity you already have, in this region; the module creates no SES
    resources. It lets the function send from `from` only, sets MAIL_* on it and adds an EventBridge
    Scheduler schedule that drains the notifications every minute.
    - from: the sender address, on the identity's domain and not on the sites domain itself
      (e.g. fling@mail.<hostname>). The function refuses to start otherwise.
    - from_name: the sender's display name. Default: the instance's INSTANCE_NAME.
    - reply_to: the operator's address that replies go to, on every email. Default: none.
    - identity_arn: the SES identity's ARN (arn:aws:ses:<region>:<account>:identity/<domain>).
    - configuration_set_name: a configuration set to name on each send. Default: none, so the
      identity's default configuration set applies.
    - events_topic_arn: an SNS topic the configuration set publishes bounces and complaints to.
      Accepted but not used yet: handling bounces and complaints is a later phase.
  EOT
  type = object({
    from                   = string
    from_name              = optional(string)
    reply_to               = optional(string)
    identity_arn           = string
    configuration_set_name = optional(string)
    events_topic_arn       = optional(string)
  })
  default = null

  validation {
    condition     = var.mail == null ? true : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.mail.from))
    error_message = "mail.from must be an email address."
  }

  validation {
    condition     = var.mail == null ? true : can(regex("^arn:aws[a-z-]*:ses:[a-z0-9-]+:[0-9]{12}:identity/.+$", var.mail.identity_arn))
    error_message = "mail.identity_arn must be an SES identity ARN (arn:aws:ses:<region>:<account>:identity/<name>)."
  }
}
