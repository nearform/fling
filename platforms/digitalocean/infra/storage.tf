# Blobs: a private Spaces bucket (no CDN: every read is the Node host's or a presigned URL's), and
# a key that may read and write it alone. Managing a bucket needs Spaces keys in the provider
# (SPACES_ACCESS_KEY_ID and SPACES_SECRET_ACCESS_KEY, besides the API token).

resource "digitalocean_spaces_bucket" "sites" {
  name   = local.bucket
  region = var.region
  acl    = "private"

  # Chunked MCP uploads are staged under uploads/<id>/ for at most an hour; sweep any leftovers.
  # Uploads presigned to sites/<id>/_staged/ are deleted by the host's hourly maintenance once
  # their URLs expire, which no prefix rule can match.
  lifecycle_rule {
    id                                     = "expire-staged-uploads"
    enabled                                = true
    prefix                                 = "uploads/"
    abort_incomplete_multipart_upload_days = 7

    expiration {
      days = 1
    }
  }
}

resource "digitalocean_spaces_key" "fling" {
  name = "${var.name}-sites"

  grant {
    bucket     = digitalocean_spaces_bucket.sites.name
    permission = "readwrite"
  }
}
