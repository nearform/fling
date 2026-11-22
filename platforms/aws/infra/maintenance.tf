# -----------------------------------------------------------------------------
# Maintenance's tick: {"fling":"maintain"} every 15 minutes (MAINTAIN_EVERY_MS: the sites queued
# for maintenance, then a sweep of every site; version retention, VERSION_RETENTION, and deleting
# replaced rendered pages: apps/api/src/maintenance.ts), which also takes due entries off the
# edge's revocation list. Each run takes up to 4 minutes of the function's timeout (var.lambda).
# Always on: with retention off it only tidies.
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "maintain_trust" {
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

resource "aws_iam_role" "maintain" {
  name               = "${local.name}-maintain"
  assume_role_policy = data.aws_iam_policy_document.maintain_trust.json
}

data "aws_iam_policy_document" "maintain" {
  statement {
    sid       = "InvokeApi"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.api.arn]
  }
}

resource "aws_iam_role_policy" "maintain" {
  name   = "invoke-api"
  role   = aws_iam_role.maintain.id
  policy = data.aws_iam_policy_document.maintain.json
}

resource "aws_scheduler_schedule" "maintain" {
  name                = "${local.name}-maintain"
  description         = "Runs ${var.name} (${var.env})'s maintenance every 15 minutes."
  schedule_expression = "rate(15 minutes)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.api.arn
    role_arn = aws_iam_role.maintain.arn
    input    = jsonencode({ fling = "maintain" })

    # A missed tick waits for the next one, which carries on where the last stopped.
    retry_policy {
      maximum_event_age_in_seconds = 300
      maximum_retry_attempts       = 0
    }
  }
}
