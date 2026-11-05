# -----------------------------------------------------------------------------
# Maintenance's tick: {"fling":"maintain"} every hour (version retention, VERSION_RETENTION, and
# deleting replaced rendered pages: apps/api/src/maintenance.ts). Always on: with retention off
# it only tidies, and does nothing on an instance without Paths.
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
  description         = "Runs ${var.name} (${var.env})'s maintenance every hour."
  schedule_expression = "rate(1 hour)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.api.arn
    role_arn = aws_iam_role.maintain.arn
    input    = jsonencode({ fling = "maintain" })

    # A missed tick waits for the next hour, which starts from the top.
    retry_policy {
      maximum_event_age_in_seconds = 300
      maximum_retry_attempts       = 0
    }
  }
}
