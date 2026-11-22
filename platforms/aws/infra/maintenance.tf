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

# -----------------------------------------------------------------------------
# The route table's size: the KeyValueStore holds 5 MB, and a site can't go live once it is full.
# Each maintenance run logs how full it is (apps/api/src/maintenance.ts): "route table usage", or
# from 70% up "route table nearly full", which the filter counts (the logs are text, so it matches
# the message); one in an hour sets the alarm off. Room is made by choosing the compact format in
# Admin → Routes.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "route_table_full" {
  name           = "${local.name}-route-table-full"
  log_group_name = aws_cloudwatch_log_group.this.name
  pattern        = "\"route table nearly full\""

  metric_transformation {
    name          = "RouteTableFull"
    namespace     = "Fling/${local.name}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "route_table_full" {
  alarm_name          = "${local.name}-route-table-full"
  alarm_description   = "${var.name} (${var.env})'s route table (CloudFront KeyValueStore) is 70% full or more. Choose the compact route format in Admin → Routes, or archive unused sites."
  namespace           = "Fling/${local.name}"
  metric_name         = aws_cloudwatch_log_metric_filter.route_table_full.metric_transformation[0].name
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
}

# -----------------------------------------------------------------------------
# Saved Logs Insights queries (CloudWatch → Logs Insights → Saved queries, under <name>/): how long
# maintenance takes to go round every site, how full the route table is, and how often a
# KeyValueStore write lost the race for its ETag (platforms/aws/src/route-table/cloudfront.ts).
# The function logs in the Text format, so each JSON line follows Lambda's prefix: the queries
# match the message as text, as the metric filter does, and parse the numbers out of it.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_query_definition" "maintenance_lap" {
  name            = "${local.name}/maintenance-lap"
  log_group_names = [aws_cloudwatch_log_group.this.name]
  query_string    = <<-EOT
    fields @timestamp
    | filter @message like /"msg":"maintenance lap"/
    | parse @message /"lapMs":(?<lapMs>\d+)/
    | stats count() as laps, avg(lapMs) as avgLapMs, max(lapMs) as maxLapMs by bin(1d)
  EOT
}

resource "aws_cloudwatch_query_definition" "route_table_usage" {
  name            = "${local.name}/route-table-usage"
  log_group_names = [aws_cloudwatch_log_group.this.name]
  query_string    = <<-EOT
    fields @timestamp
    | filter @message like /"msg":"route table (usage|nearly full)"/
    | parse @message /"bytes":(?<bytes>\d+),"limitBytes":(?<limitBytes>\d+),"percent":(?<percent>[\d.]+)/
    | stats max(bytes) as maxBytes, max(limitBytes) as limitBytes, max(percent) as maxPercent by bin(1h)
  EOT
}

resource "aws_cloudwatch_query_definition" "kvs_write_retried" {
  name            = "${local.name}/kvs-write-retried"
  log_group_names = [aws_cloudwatch_log_group.this.name]
  query_string    = <<-EOT
    fields @timestamp
    | filter @message like /"msg":"kvs write retried"/
    | parse @message /"attempts":(?<attempts>\d+)/
    | stats count() as retried, sum(attempts) as retries, max(attempts) as maxAttempts by bin(1h)
  EOT
}
