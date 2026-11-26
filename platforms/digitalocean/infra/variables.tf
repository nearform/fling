variable "name" {
  description = "The instance's name in DigitalOcean: the app, the database cluster and the key are named after it. Lower case letters, digits and hyphens."
  type        = string
  default     = "fling"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.name))
    error_message = "name must be 3 to 32 lower case letters, digits and hyphens, starting with a letter."
  }
}

variable "region" {
  description = "The datacentre for the database and the Spaces bucket (ams3, fra1, lon1, nyc3, sfo3, sgp1, syd1, tor1, blr1). The app runs in the same region (its first letters: ams, fra, …)."
  type        = string
  default     = "ams3"

  validation {
    condition     = can(regex("^[a-z]+[0-9]$", var.region))
    error_message = "region is a datacentre slug such as ams3 or nyc3."
  }
}

variable "app_host" {
  description = "The app's host name (the UI and the API), e.g. fling.example.com. APP_ORIGIN is https://<app_host>."
  type        = string
}

variable "sites_domain" {
  description = "Sites are https://<name>.<sites_domain>. May equal app_host; must share its registrable domain (the site cookie is set on it)."
  type        = string
}

variable "site_cookie_domain" {
  description = "SITE_COOKIE_DOMAIN: the domain the site cookie is set on. Default: sites_domain."
  type        = string
  default     = null
}

variable "dns_zone" {
  description = "A domain in this DigitalOcean account (Networking → Domains) that holds app_host and sites_domain. App Platform then adds the records and verifies the wildcard certificate itself. Null: you add the records at your DNS provider (the dns output says which)."
  type        = string
  default     = null
}

variable "image_tag" {
  description = "The Node host image's tag in the registry when the app is created. Afterwards the deploy workflow sets the tag (Terraform ignores it), so changing this does nothing."
  type        = string
}

variable "registry_name" {
  description = "The DigitalOcean Container Registry the image is pushed to (an account has one)."
  type        = string
}

variable "create_registry" {
  description = "Create the registry here. False: it already exists in the account."
  type        = bool
  default     = true
}

variable "registry_tier" {
  description = "The registry's subscription tier when it is created here (starter holds one repository and 500 MB; basic is enough for Fling's tags)."
  type        = string
  default     = "basic"
}

variable "instance_size_slug" {
  description = "The App Platform instance size of the Node host."
  type        = string
  default     = "apps-s-1vcpu-1gb"
}

variable "instance_count" {
  description = "How many Node host containers run. More than one is fine: they share the Table in Postgres and their live rooms through Postgres LISTEN/NOTIFY, and every tick is safe to repeat."
  type        = number
  default     = 1

  validation {
    condition     = var.instance_count >= 1 && floor(var.instance_count) == var.instance_count
    error_message = "instance_count is a whole number, at least 1."
  }
}

variable "database_size" {
  description = "The managed Postgres cluster's node size."
  type        = string
  default     = "db-s-1vcpu-1gb"
}

variable "database_node_count" {
  description = "Nodes in the Postgres cluster (1 primary; 2 or 3 adds standbys)."
  type        = number
  default     = 1
}

variable "postgres_version" {
  description = "The Postgres major version."
  type        = string
  default     = "17"
}

variable "bucket_name" {
  description = "The Spaces bucket for site files (names are unique per region). Default: <name>-sites."
  type        = string
  default     = null
}

variable "instance" {
  description = "The instance's own configuration, passed to the Node host as environment variables: INSTANCE_NAME, ALLOWED_EMAIL_DOMAINS / ALLOWED_EMAILS, ADMIN_EMAILS, OIDC_*, BRAND_*, MAIL_* and SMTP_*, … (platforms/aws/DEPLOY.md, Instance configuration). Not secrets: those go in instance_secrets."
  type        = map(string)
  default     = {}

  validation {
    condition = length(setintersection(keys(var.instance), [
      "APP_ENV", "APP_ORIGIN", "SITES_DOMAIN", "SITE_COOKIE_DOMAIN", "LIVE_URL", "PORT", "FS_ROOT",
      "STORE_DRIVER", "STORAGE_DRIVER", "KVS_DRIVER", "SITES_BUCKET", "DATABASE_URL",
      "DATABASE_CA_CERT", "S3_ENDPOINT", "S3_PUBLIC_ENDPOINT", "S3_REGION", "S3_FORCE_PATH_STYLE",
      "S3_UPLOAD_DIGEST", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "SESSION_SECRET",
      "SITE_HMAC_KEY", "TICK_SECRET", "DEV_LOGIN",
    ])) == 0
    error_message = "instance sets a variable the module owns (addresses, drivers, storage, database or the generated secrets)."
  }

  validation {
    condition     = lower(lookup(var.instance, "SERVERS", "off")) == "off"
    error_message = "SERVERS stays off on App Platform: site servers need a sandboxed runtime, which App Platform does not offer."
  }
}

variable "instance_secrets" {
  description = "The instance's secrets, passed as encrypted App Platform environment variables: OIDC_CLIENT_SECRET, GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, SMTP_PASSWORD, SLACK_SIGNING_SECRET / SLACK_BOT_TOKEN. They are kept in Terraform state too."
  type        = map(string)
  default     = {}
  sensitive   = true

  # The same keys as instance's are refused here, so nothing the module owns, and no SERVERS,
  # comes in as a secret instead. Only the names are checked; the values stay sensitive.
  validation {
    condition = length(setintersection(nonsensitive(keys(var.instance_secrets)), [
      "APP_ENV", "APP_ORIGIN", "SITES_DOMAIN", "SITE_COOKIE_DOMAIN", "LIVE_URL", "PORT", "FS_ROOT",
      "STORE_DRIVER", "STORAGE_DRIVER", "KVS_DRIVER", "SITES_BUCKET", "DATABASE_URL",
      "DATABASE_CA_CERT", "S3_ENDPOINT", "S3_PUBLIC_ENDPOINT", "S3_REGION", "S3_FORCE_PATH_STYLE",
      "S3_UPLOAD_DIGEST", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "SESSION_SECRET",
      "SITE_HMAC_KEY", "TICK_SECRET", "DEV_LOGIN",
    ])) == 0
    error_message = "instance_secrets sets a variable the module owns (addresses, drivers, storage, database or the generated secrets)."
  }

  validation {
    condition     = !contains(nonsensitive(keys(var.instance_secrets)), "SERVERS")
    error_message = "SERVERS stays off on App Platform, and is not a secret: leave it out of instance_secrets."
  }
}

variable "alert_emails" {
  description = "Team members' addresses for failed deploys and domains. Empty: the team's own address."
  type        = list(string)
  default     = []
}
