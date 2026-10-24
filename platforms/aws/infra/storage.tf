# Two buckets, both private, read by their CloudFront distribution only (Origin Access Control):
# - ui: the app's SPA. The deploy workflow syncs it, keeping old hashed assets so open tabs still load
#   their chunks.
# - sites: every version of every site, under sites/<siteId>/<versionId>/, written by the CLI through
#   presigned PUTs that the API signs. The error page lives under _fling/, written by the deploy workflow.
#
# Both distributions may list their bucket, so a missing key is a 404 rather than a 403. Bucket names
# are global: var.bucket_prefix keeps them unique (<bucket_prefix><namespace>-<env>-<name>-ui).

resource "aws_s3_bucket" "ui" {
  bucket = "${var.bucket_prefix}${local.name}-ui"
}

resource "aws_s3_bucket" "sites" {
  bucket = "${var.bucket_prefix}${local.name}-sites"

  # Holds what people have published. Removing the app from Terraform should not quietly empty it.
  lifecycle {
    prevent_destroy = true
  }
}

locals {
  buckets = {
    ui    = aws_s3_bucket.ui
    sites = aws_s3_bucket.sites
  }

  bucket_readers = {
    ui    = aws_cloudfront_distribution.app.arn
    sites = aws_cloudfront_distribution.sites.arn
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each = local.buckets

  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = local.buckets

  bucket = each.value.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = local.buckets

  bucket = each.value.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# A deploy the CLI abandons halfway leaves no parts behind.
resource "aws_s3_bucket_lifecycle_configuration" "this" {
  for_each = local.buckets

  bucket = each.value.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # Chunked MCP uploads are staged under uploads/<id>/ for at most an hour; sweep any leftovers.
  # (Only the sites bucket ever has this prefix; the rule is a no-op on the ui bucket.)
  rule {
    id     = "expire-staged-uploads"
    status = "Enabled"

    filter {
      prefix = "uploads/"
    }

    expiration {
      days = 1
    }
  }
}

data "aws_iam_policy_document" "bucket" {
  for_each = local.buckets

  statement {
    sid       = "CloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${each.value.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [local.bucket_readers[each.key]]
    }
  }

  statement {
    sid       = "CloudFrontList"
    actions   = ["s3:ListBucket"]
    resources = [each.value.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [local.bucket_readers[each.key]]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [each.value.arn, "${each.value.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  for_each = local.buckets

  bucket = each.value.id
  policy = data.aws_iam_policy_document.bucket[each.key].json

  depends_on = [aws_s3_bucket_public_access_block.this]
}
