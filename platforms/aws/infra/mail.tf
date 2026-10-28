# Email (var.mail): the notifications' email channel on SES v2, from an identity the operator
# already has. Nothing here exists without var.mail.
#
# - The function sends with SES's SendEmail, one call per recipient (src/mail/ses.ts). Its role may
#   send only from var.mail.from (the ses:FromAddress condition), on that identity and on the
#   configuration set, when one is named. SES authorises a send on the identity and on the
#   configuration set it uses, so a named set needs its own grant; the identity's default set is
#   already covered by the identity's.
# - MAIL_* and SES_CONFIGURATION_SET reach the function's environment (api.tf); var.environment
#   and var.instance may not set them.
# - /notifications/* (the emails' unsubscribe page) joins the app distribution's API behaviours
#   (edge.tf), whatever var.api_paths is.
# - EventBridge Scheduler invokes the function every minute with {"fling":"notify"}, which drains
#   the notifications' outbox. The scheduler invokes through its own role, so the function needs no
#   resource-based permission for it (unlike an EventBridge rule).
#
# The module creates no SES resources: the identity, its DKIM, MAIL FROM and DMARC records, the
# configuration set and production access are the operator's (DEPLOY.md, Email).

locals {
  mail = var.mail == null ? null : merge(var.mail, { from = lower(var.mail.from) })

  # arn:<partition>:ses:<region>:<account>:identity/<name>
  mail_identity = local.mail == null ? null : split(":", local.mail.identity_arn)
  mail_configuration_set_arn = (
    local.mail == null ? null : (
      local.mail.configuration_set_name == null ? null : join(":", [
        "arn", local.mail_identity[1], "ses", local.mail_identity[3], local.mail_identity[4],
        "configuration-set/${local.mail.configuration_set_name}",
      ])
    )
  )

  api_paths = local.mail == null ? var.api_paths : distinct(concat(var.api_paths, ["/notifications/*"]))

  mail_environment = local.mail == null ? {} : {
    for k, v in {
      MAIL_DRIVER           = "ses"
      MAIL_FROM             = local.mail.from
      MAIL_FROM_NAME        = local.mail.from_name
      MAIL_REPLY_TO         = local.mail.reply_to
      SES_CONFIGURATION_SET = local.mail.configuration_set_name
    } : k => v if v != null
  }
}

data "aws_iam_policy_document" "mail" {
  count = local.mail == null ? 0 : 1

  statement {
    sid     = "SendEmail"
    actions = ["ses:SendEmail"]
    resources = compact([
      local.mail.identity_arn,
      local.mail_configuration_set_arn,
    ])

    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [local.mail.from]
    }
  }
}

resource "aws_iam_role_policy" "mail" {
  count = local.mail == null ? 0 : 1

  name   = "mail"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.mail[0].json
}

# -----------------------------------------------------------------------------
# The notifications' tick: {"fling":"notify"} every minute.
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "scheduler_trust" {
  count = local.mail == null ? 0 : 1

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "notify" {
  count = local.mail == null ? 0 : 1

  name               = "${local.name}-notify"
  assume_role_policy = data.aws_iam_policy_document.scheduler_trust[0].json
}

data "aws_iam_policy_document" "notify" {
  count = local.mail == null ? 0 : 1

  statement {
    sid       = "InvokeApi"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.api.arn]
  }
}

resource "aws_iam_role_policy" "notify" {
  count = local.mail == null ? 0 : 1

  name   = "invoke-api"
  role   = aws_iam_role.notify[0].id
  policy = data.aws_iam_policy_document.notify[0].json
}

resource "aws_scheduler_schedule" "notify" {
  count = local.mail == null ? 0 : 1

  name                = "${local.name}-notify"
  description         = "Drains ${var.name} (${var.env})'s notifications every minute."
  schedule_expression = "rate(1 minute)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.api.arn
    role_arn = aws_iam_role.notify[0].arn
    input    = jsonencode({ fling = "notify" })

    # A missed tick only delays mail until the next one, which drains from where the last stopped.
    retry_policy {
      maximum_event_age_in_seconds = 60
      maximum_retry_attempts       = 0
    }
  }
}
