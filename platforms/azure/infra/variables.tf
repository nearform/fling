variable "namespace" {
  description = <<-EOT
    Prefix of every resource name: <namespace>-<env>-<name> (e.g. acme-production-fling). Your
    organisation or platform name. Names Azure keeps global (the storage account, the registry, the
    Key Vault, the Cosmos DB account, Web PubSub) also get a short random suffix.
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

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*$", var.env))
    error_message = "env: lowercase letters, digits and hyphens."
  }
}

variable "name" {
  description = "The app's name in resource names (<namespace>-<env>-<name>)."
  type        = string
  default     = "fling"
}

variable "location" {
  description = "The Azure region every resource is in, for example westeurope."
  type        = string
}

variable "resource_group_name" {
  description = "An existing resource group to put everything in. null: the module creates <namespace>-<env>-<name>."
  type        = string
  default     = null
}

variable "hostname" {
  description = <<-EOT
    The app's hostname, for example fling.example.test. The UI and API are served there.
  EOT
  type        = string
}

variable "sites_domain" {
  description = <<-EOT
    Where sites are served: https://<name>.<sites_domain>. null: the hostname, so sites are on its
    subdomains. It must share the hostname's registrable domain (the fling_site cookie is set on it).
  EOT
  type        = string
  default     = null
}

variable "dns_zone" {
  description = <<-EOT
    An Azure DNS zone holding the hostname and the sites domain (dns.tf). The module adds Front
    Door's validation TXT records, the hostname's and the wildcard's records and, with mail, the
    sending domain's. null: add them yourself from the dns_records output.
  EOT
  type = object({
    name                = string
    resource_group_name = string
  })
  default = null
}

variable "github" {
  description = <<-EOT
    The repository whose deploy workflow (.github/workflows/deploy-azure.yml) ships Fling, as
    owner/repo, and the GitHub environment its job runs in. Only that environment's jobs can sign
    in as the deploy identity (the federated credential's subject).
  EOT
  type = object({
    repository  = string
    environment = optional(string, "azure")
  })

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github.repository))
    error_message = "github.repository is owner/repo."
  }
}

variable "environment" {
  description = <<-EOT
    Extra or overriding environment variables for the app and its jobs. The module sets the
    plumbing (APP_ENV, APP_ORIGIN, SITES_DOMAIN, SITE_SCHEME, SITE_COOKIE_DOMAIN, the drivers and
    the Azure endpoints, LIVE_URL). Not secret: they are in the Container App's configuration.
    Instance values belong in var.instance. MAIL_* and ACS_* are refused: email is set in var.mail.
  EOT
  type        = map(string)
  default     = {}

  validation {
    condition     = length([for k in keys(var.environment) : k if can(regex("^(MAIL|ACS)_", k))]) == 0
    error_message = "environment may not set MAIL_* or ACS_*: email is set in var.mail."
  }
}

variable "instance" {
  description = <<-EOT
    The instance's own values (ALLOWED_EMAIL_DOMAINS and/or ALLOWED_EMAILS, OIDC_ISSUER,
    OIDC_CLIENT_ID, INSTANCE_NAME, BRAND_*...; platforms/aws/DEPLOY.md, Instance configuration),
    passed through as INSTANCE in the deploy output. The deploy workflow builds them into the image
    as instance.json, so they need no apply to reach it, only a redeploy. MAIL_* and ACS_* are
    refused: email is set in var.mail.
  EOT
  type        = map(string)
  default     = {}

  validation {
    condition     = length([for k in keys(var.instance) : k if can(regex("^(MAIL|ACS)_", k))]) == 0
    error_message = "instance may not set MAIL_* or ACS_*: email is set in var.mail."
  }
}

variable "container" {
  description = <<-EOT
    The app's size and scale. min_replicas 0 scales to zero when idle (the first request after waits
    for a replica to start); 1 keeps one warm. cpu and memory are a Consumption pair (0.5 and 1Gi,
    1 and 2Gi, ...).
  EOT
  type = object({
    cpu          = optional(number, 0.5)
    memory       = optional(string, "1Gi")
    min_replicas = optional(number, 0)
    max_replicas = optional(number, 3)
  })
  default = {}
}

variable "web_pubsub_sku" {
  description = "Web PubSub's tier for the live rooms: Free_F1 (20 connections, 20k messages a day) or Standard_S1."
  type        = string
  default     = "Free_F1"
}

variable "generated_secrets" {
  description = <<-EOT
    Key Vault secrets whose values Terraform generates (40 random characters). Generated in memory
    and written with a write-only attribute, so never in state.
  EOT
  type        = list(string)
  default     = ["session-secret", "site-hmac-key"]
}

variable "manual_secrets" {
  description = <<-EOT
    Key Vault secrets someone fills by hand or by script (az keyvault secret set). Terraform creates
    them with the value "unset" and never looks at the value again. oidc-client-secret is the
    OIDC_ISSUER client's secret; a Google client's id and secret are google-client-id and
    google-client-secret (either client, or both); a Slack app's are slack-signing-secret and
    slack-bot-token. Each one reaches the app as its env name (OIDC_CLIENT_SECRET,
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN).
  EOT
  type        = list(string)
  default     = ["oidc-client-secret"]

  validation {
    condition = alltrue([
      for s in var.manual_secrets : contains(["oidc-client-secret", "google-client-id", "google-client-secret", "slack-signing-secret", "slack-bot-token"], s)
    ])
    error_message = "manual_secrets holds oidc-client-secret, google-client-id, google-client-secret, slack-signing-secret and/or slack-bot-token."
  }
}

variable "secrets_version" {
  description = <<-EOT
    Bump to regenerate every generated secret, the X-Origin-Verify header and the live events
    secret. Running replicas keep the old values until they restart: redeploy afterwards.
  EOT
  type        = number
  default     = 1
}

variable "log_retention_days" {
  description = "How long the app's and the jobs' logs are kept in Log Analytics."
  type        = number
  default     = 30
}

variable "mail" {
  description = <<-EOT
    Email, for notifications (mail.tf; DEPLOY.md, Email). null: no email, and none of mail.tf
    exists. Sends through Azure Communication Services Email from a domain of yours, verified by
    the DNS records the module adds (with var.dns_zone) or that you add (the dns_records output).
    - domain: the sending domain. Default mail.<sites_domain> (`mail` is a reserved site name).
    - username: the sender's local part; MAIL_FROM is <username>@<domain>. Default fling.
    - from_name: the sender's display name. Communication Services takes it from the sender
      username, not from the message, so MAIL_FROM_NAME has no effect on Azure. Default the name.
    - reply_to: the operator's address replies go to, on every email. Default: none.
    - data_location: where Communication Services keeps its data (Europe, United States, UK, ...).
  EOT
  type = object({
    domain        = optional(string)
    username      = optional(string, "fling")
    from_name     = optional(string)
    reply_to      = optional(string)
    data_location = optional(string, "Europe")
  })
  default = null

  validation {
    condition     = var.mail == null ? true : can(regex("^[a-z0-9][a-z0-9._-]*$", var.mail.username))
    error_message = "mail.username: lowercase letters, digits, dots, hyphens and underscores."
  }
}

variable "tags" {
  description = "Tags on every resource that takes them."
  type        = map(string)
  default     = {}
}
