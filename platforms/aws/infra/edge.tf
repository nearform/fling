# CloudFront in front of everything, two distributions on one certificate:
# - app (<hostname>): the SPA from the ui bucket by default, api_paths to the function URL uncached.
#   No distribution-level custom error responses: they would replace the API's own 404s.
# - sites (*.<hostname>): every site, from the sites bucket. A viewer-request CloudFront Function (the
#   site router) maps the Host to the site's current version through the KeyValueStore, checks the
#   sign-in cookie for private sites, and rewrites the URI to sites/<siteId>/<versionId>/<path>. The
#   cache key is that rewritten URI, so one cache policy serves every site.

# AWS managed policies, by their fixed ids.
locals {
  cache_policy_caching_disabled                = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
  cache_policy_caching_optimized               = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
  origin_request_policy_all_viewer_except_host = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # Managed-AllViewerExceptHostHeader
  response_headers_policy_security_headers     = "67f7725c-6f97-4210-82d7-5512b31e9d03" # Managed-SecurityHeadersPolicy
  cloudfront_hosted_zone_id                    = "Z2FDTNDATAQYW2"
  sites_hostname                               = "*.${var.hostname}"
}

# -----------------------------------------------------------------------------
# Certificate, in us-east-1 for CloudFront: the hostname and every name one level below it. ACM
# validates both with the same CNAME, so only the hostname's record is written.
# -----------------------------------------------------------------------------

resource "aws_acm_certificate" "this" {
  provider = aws.us_east_1

  domain_name               = var.hostname
  subject_alternative_names = [local.sites_hostname]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for o in aws_acm_certificate.this.domain_validation_options : o.domain_name => o
    if !startswith(o.domain_name, "*.")
  }

  zone_id         = var.zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  ttl             = 300
  records         = [each.value.resource_record_value]
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# -----------------------------------------------------------------------------
# Edge functions and the KeyValueStore (all global).
# -----------------------------------------------------------------------------

# What the site router reads: site:<host> and share:<token> → {id, v, vis, ...}, plus the cookie
# HMAC key. Written by the API only.
resource "aws_cloudfront_key_value_store" "sites" {
  name    = "${local.name}-sites"
  comment = "${var.name} (${var.env}): site hosts and share tokens → current version. Written by the API."
}

# The site router. Its real code is edge/dist/site-router.js (built by edge/build.mjs) in the Fling
# repository, published by the deploy workflow (update-function + publish-function). Terraform
# creates it with a placeholder and ignores the code from then on.
resource "aws_cloudfront_function" "site_router" {
  name                         = "${local.name}-site-router"
  comment                      = "${var.name} (${var.env}) site router. Code deployed by ${var.github.owner}/${var.github.repo}."
  runtime                      = "cloudfront-js-2.0"
  publish                      = true
  key_value_store_associations = [aws_cloudfront_key_value_store.sites.arn]

  code = <<-EOT
    // Placeholder until the first deploy publishes edge/src/site-router.js.
    function handler(event) {
      return event.request;
    }
  EOT

  lifecycle {
    ignore_changes = [code]
  }
}

# The SPA on the app hostname: a path without a file extension is a client-side route, so it gets
# index.html. Hashed assets and other files are served as they are.
resource "aws_cloudfront_function" "spa" {
  name    = "${local.name}-spa"
  comment = "${var.name} (${var.env}): extensionless paths → /index.html."
  runtime = "cloudfront-js-2.0"
  publish = true

  code = <<-EOT
    function handler(event) {
      var request = event.request;
      var last = request.uri.substring(request.uri.lastIndexOf('/') + 1);
      if (last.indexOf('.') === -1) {
        request.uri = '/index.html';
      }
      return request;
    }
  EOT
}

# -----------------------------------------------------------------------------
# Distributions.
# -----------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "this" {
  for_each = local.buckets

  name                              = "${local.name}-${each.key}"
  description                       = "CloudFront reads ${each.value.bucket}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "app" {
  enabled         = true
  comment         = "${var.name} (${var.env}): UI and API"
  aliases         = [var.hostname]
  http_version    = "http2and3"
  is_ipv6_enabled = true

  # PriceClass_100 (the default): Europe and North America edges only, the cheapest class.
  price_class = var.price_class

  origin {
    origin_id                = "ui"
    domain_name              = aws_s3_bucket.ui.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.this["ui"].id
  }

  # The function URL checks its own Host, so the viewer's Host is not passed on
  # (AllViewerExceptHostHeader). The app knows its public origin from APP_ORIGIN.
  origin {
    origin_id   = "api"
    domain_name = split("/", aws_lambda_function_url.api.function_url)[2]

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 5
    }

    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
  }

  default_cache_behavior {
    target_origin_id           = "ui"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = local.cache_policy_caching_optimized
    response_headers_policy_id = local.response_headers_policy_security_headers
    compress                   = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa.arn
    }
  }

  dynamic "ordered_cache_behavior" {
    for_each = var.api_paths

    content {
      path_pattern               = ordered_cache_behavior.value
      target_origin_id           = "api"
      viewer_protocol_policy     = "redirect-to-https"
      allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
      cached_methods             = ["GET", "HEAD"]
      cache_policy_id            = local.cache_policy_caching_disabled
      origin_request_policy_id   = local.origin_request_policy_all_viewer_except_host
      response_headers_policy_id = local.response_headers_policy_security_headers
      compress                   = true
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.this.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

resource "aws_cloudfront_distribution" "sites" {
  enabled         = true
  comment         = "${var.name} (${var.env}): sites"
  aliases         = [local.sites_hostname]
  http_version    = "http2and3"
  is_ipv6_enabled = true
  price_class     = var.price_class

  origin {
    origin_id                = "sites"
    domain_name              = aws_s3_bucket.sites.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.this["sites"].id
  }

  default_cache_behavior {
    target_origin_id       = "sites"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.cache_policy_caching_optimized
    compress               = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.site_router.arn
    }
  }

  # The error page's directory, without the site router, so CloudFront can always fetch the error page
  # whatever the host. Sites cannot use this path.
  ordered_cache_behavior {
    path_pattern           = "${dirname(var.error_page_path)}/*"
    target_origin_id       = "sites"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.cache_policy_caching_optimized
    compress               = true
  }

  # A missing file (404, as CloudFront may list the bucket) or anything S3 refuses (403), on any site or
  # an unknown host (the router sends those to a key that does not exist): the error page, as a 404.
  dynamic "custom_error_response" {
    for_each = [403, 404]

    content {
      error_code         = custom_error_response.value
      response_code      = 404
      response_page_path = var.error_page_path
      # Never cache "not found": a site or share link that appears seconds later (KeyValueStore
      # writes reach the edge asynchronously) must work on the next reload.
      error_caching_min_ttl = 0
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.this.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

# -----------------------------------------------------------------------------
# DNS: the hostname to the app distribution, every name below it to the sites distribution.
# -----------------------------------------------------------------------------

locals {
  dns = {
    app   = { name = var.hostname, distribution = aws_cloudfront_distribution.app }
    sites = { name = local.sites_hostname, distribution = aws_cloudfront_distribution.sites }
  }

  dns_records = merge([
    for k, d in local.dns : {
      for type in ["A", "AAAA"] : "${k}-${type}" => merge(d, { type = type })
    }
  ]...)
}

resource "aws_route53_record" "this" {
  for_each = local.dns_records

  zone_id = var.zone_id
  name    = each.value.name
  type    = each.value.type

  alias {
    name                   = each.value.distribution.domain_name
    zone_id                = local.cloudfront_hosted_zone_id
    evaluate_target_health = false
  }
}
