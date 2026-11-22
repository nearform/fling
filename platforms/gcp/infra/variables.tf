variable "project_id" {
  description = "The Google Cloud project the instance runs in. One project can hold several instances."
  type        = string
}

variable "region" {
  description = <<-EOT
    The region of the Cloud Run service, its serverless NEG, the Artifact Registry repository, the
    sites bucket and the Cloud Scheduler jobs, for example europe-west1.
  EOT
  type        = string
}

variable "firestore_location" {
  description = <<-EOT
    Where the Firestore database is: a region (eur3 and nam5 are multi-regions). null: var.region.
    It can't be changed once the database exists.
  EOT
  type        = string
  default     = null
}

variable "namespace" {
  description = <<-EOT
    Prefix of every resource name: <namespace>-<env>-<name> (e.g. acme-production-fling). Your
    organisation or platform name.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*$", var.namespace))
    error_message = "namespace: lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "env" {
  description = "Environment, for example production. Part of every resource name."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*$", var.env))
    error_message = "env: lowercase letters, digits and hyphens."
  }
}

variable "name" {
  description = "The app's name in resource names (<namespace>-<env>-<name>) and descriptions."
  type        = string
  default     = "fling"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*$", var.name))
    error_message = "name: lowercase letters, digits and hyphens."
  }
}

variable "bucket_prefix" {
  description = <<-EOT
    Prepended to the sites bucket's name (<bucket_prefix><namespace>-<env>-<name>-sites), which must
    be unique across all of Cloud Storage. For example "acme-", or "" for none.
  EOT
  type        = string
  default     = ""
}

variable "hostname" {
  description = <<-EOT
    The app's hostname, for example fling.example.test. The UI and API are served there, and every
    site on a subdomain of it (*.<hostname>).
  EOT
  type        = string
}

variable "dns_zone" {
  description = <<-EOT
    The Cloud DNS managed zone (its name, in var.project_id) the hostname, the wildcard and the
    certificate's DNS authorisation go in. null: you add the records yourself, from the dns_records
    output, wherever the domain's DNS is.
  EOT
  type        = string
  default     = null
}

variable "github" {
  description = <<-EOT
    The repository whose deploy workflow ships Fling (the upstream repository, or your fork). Trust
    is on GitHub's numeric ids (gh api repos/<owner>/<repo> --jq '.owner.id, .id'), which survive a
    rename. Only jobs in the named GitHub environment can deploy.
  EOT
  type = object({
    owner       = string
    owner_id    = string
    repo        = string
    repo_id     = string
    environment = optional(string, "gcp")
  })
}

variable "environment" {
  description = <<-EOT
    Extra or overriding environment variables for the service. The module already sets APP_ENV,
    APP_ORIGIN, SITES_DOMAIN, SITE_SCHEME and SITE_COOKIE_DOMAIN (from the hostname) and LIVE_URL
    (var.live), and always sets FIRESTORE_DATABASE, TABLE_NAME, SITES_BUCKET and
    TICK_SERVICE_ACCOUNTS. Not secret: they are in the service's configuration. Instance values
    belong in var.instance instead. MAIL_* and SMTP_* are refused: email is set in var.mail.
  EOT
  type        = map(string)
  default     = {}

  validation {
    condition     = length([for k in keys(var.environment) : k if can(regex("^(MAIL|SMTP|SES)_", k))]) == 0
    error_message = "environment may not set MAIL_*, SMTP_* or SES_*: email is set in var.mail."
  }
}

variable "instance" {
  description = <<-EOT
    The instance's own values (ALLOWED_EMAIL_DOMAINS and/or ALLOWED_EMAILS, OIDC_ISSUER,
    OIDC_CLIENT_ID, INSTANCE_NAME, BRAND_*...; see platforms/aws/DEPLOY.md, Instance configuration),
    passed through as INSTANCE in the deploy output. The deploy workflow writes them into the image,
    so they need no apply to reach it, only a redeploy. Empty: the deploy output has no INSTANCE (add
    it yourself). MAIL_*, SMTP_* and SES_* are refused: email is set in var.mail.
  EOT
  type        = map(string)
  default     = {}

  validation {
    condition     = length([for k in keys(var.instance) : k if can(regex("^(MAIL|SMTP|SES)_", k))]) == 0
    error_message = "instance may not set MAIL_*, SMTP_* or SES_*: email is set in var.mail."
  }
}

variable "service" {
  description = <<-EOT
    The Cloud Run service's size and scaling.
    - cpu, memory: each instance's limits.
    - min_instances: instances kept warm (0 scales to zero; 1 removes cold starts, for a fee).
    - max_instances: the most instances. Live rooms (var.live) need 1: every socket of a room must be
      in one process.
    - concurrency: requests one instance serves at once.
    - timeout_seconds: the longest request, and so the longest a live room's WebSocket stays open
      before the page reconnects (at most 3600).
  EOT
  type = object({
    cpu             = optional(string, "1")
    memory          = optional(string, "512Mi")
    min_instances   = optional(number, 0)
    max_instances   = optional(number, 1)
    concurrency     = optional(number, 250)
    timeout_seconds = optional(number, 3600)
  })
  default = {}

  validation {
    condition     = var.service.max_instances >= 1 && var.service.min_instances <= var.service.max_instances
    error_message = "service: max_instances is at least 1 and at least min_instances."
  }

  validation {
    condition     = var.service.timeout_seconds >= 60 && var.service.timeout_seconds <= 3600
    error_message = "service.timeout_seconds is between 60 and 3600."
  }
}

variable "live" {
  description = <<-EOT
    Live rooms on review pages (LIVE_URL, the `live` capability): WebSockets to the service, whose
    rooms are in process, so they need service.max_instances = 1. false: no LIVE_URL, and review
    pages poll instead; set it to scale the service out.
  EOT
  type        = bool
  default     = true
}

variable "cdn" {
  description = <<-EOT
    Cloud CDN on the sites' backend (*.<hostname>), caching what the service marks public: public
    sites' files, never what the service sends `private` (a site that isn't public, a share link)
    or anything of the app's. Off by default, so every request reaches the service and a change of
    access or a rollback is seen at once; on, a public file may be served from the edge for up to a
    minute after it changed.
  EOT
  type        = bool
  default     = false
}

variable "generated_secrets" {
  description = <<-EOT
    Secret Manager secrets whose values Terraform generates (40 random characters). Generated in
    memory and written with a write-only attribute, so never in state. Each reaches the service as
    the environment variable of its name in upper case (session-secret: SESSION_SECRET).
  EOT
  type        = list(string)
  default     = ["session-secret", "site-hmac-key"]
}

variable "manual_secrets" {
  description = <<-EOT
    Secret Manager secrets that someone fills by hand (gcloud secrets versions add). Terraform
    creates each with the placeholder "unset", which the service reads as not set, and never looks
    at the value again. oidc-client-secret is the OIDC_ISSUER client's secret; a Google client's id
    and secret are google-client-id and google-client-secret (either client, or both). With
    var.mail, smtp-password is added.
  EOT
  type        = list(string)
  default     = ["oidc-client-secret"]
}

variable "secrets_version" {
  description = <<-EOT
    Bump to regenerate every generated secret. Running instances keep the old values until they are
    replaced: deploy again afterwards.
  EOT
  type        = number
  default     = 1
}

variable "mail" {
  description = <<-EOT
    Email, for notifications (DEPLOY.md, Email). null: no email. Google Cloud sends no mail itself,
    so it goes through a transactional provider's SMTP server (ports 465 and 587; 25 is blocked).
    Sets MAIL_* and SMTP_* on the service, adds the smtp-password secret (fill it by hand) and a
    Cloud Scheduler job that drains the notifications every minute.
    - from: the sender address, on a domain the provider sends for and not on the sites domain
      itself (e.g. fling@mail.<hostname>). The service refuses to start otherwise.
    - from_name: the sender's display name. Default: the instance's INSTANCE_NAME.
    - reply_to: the operator's address that replies go to. Default: none.
    - smtp: the server: host, port (default 587), security (tls or starttls; default from the
      port) and user.
  EOT
  type = object({
    from      = string
    from_name = optional(string)
    reply_to  = optional(string)
    smtp = object({
      host     = string
      port     = optional(number, 587)
      security = optional(string)
      user     = string
    })
  })
  default = null

  validation {
    condition     = var.mail == null ? true : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.mail.from))
    error_message = "mail.from must be an email address."
  }

  validation {
    condition     = var.mail == null ? true : (var.mail.smtp.security == null ? true : contains(["tls", "starttls"], var.mail.smtp.security))
    error_message = "mail.smtp.security is tls or starttls."
  }
}

variable "maintenance_schedule" {
  description = "When Cloud Scheduler runs maintenance (cron, in UTC): every 15 minutes, as every platform does (MAINTAIN_EVERY_MS)."
  type        = string
  default     = "*/15 * * * *"
}
