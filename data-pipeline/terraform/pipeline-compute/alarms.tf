# "Pipeline stuck": the oldest Vault export still exporting/processing has been
# in flight for over 6 hours, two hours running. vault-archive-poll publishes
# the age every run (embedded metric format, namespace MNA/Pipeline). It catches
# what the per-Lambda Errors alarm can't: an export that stops advancing for any
# reason — a crash loop, Vault, Anthropic — while each run looks fine on its own.
# A normal day's export clears within an hour.
resource "aws_cloudwatch_metric_alarm" "vault_export_stuck" {
  alarm_name = "${local.prefix}-vault-export-stuck"
  alarm_description = join(" ", [
    "A Vault export has been in flight for over 6 hours, so new mail is not",
    "reaching the CRM. Find it with: SELECT window_start, mode, status, created_at",
    "FROM analytics.vault_exports WHERE status IN ('exporting','processing');",
    "then read /aws/lambda/${local.prefix}-vault-archive-poll for that export.",
  ])
  namespace           = "MNA/Pipeline"
  metric_name         = "OldestInFlightExportMinutes"
  dimensions          = { Environment = local.environment }
  statistic           = "Maximum"
  period              = 3600
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 360
  comparison_operator = "GreaterThanThreshold"
  # No data means the poll isn't reporting at all (not deployed yet, or not
  # running); that shows as INSUFFICIENT_DATA rather than a false page.
  treat_missing_data = "missing"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = local.common_tags
}
