# AWS Chatbot -> Slack notifications for CloudWatch alarm state changes.
#
# The Lambda error alarm (modules/pipeline-lambdas) already publishes both
# alarm_actions and ok_actions to aws_sns_topic.alerts, so every crossing of
# the healthy threshold (OK -> ALARM and ALARM -> OK) lands on that topic.
# This subscribes AWS Chatbot to the topic and forwards to the per-workspace
# Slack channel (local.current_config.slack_channel_id — staging vs production).
#
# Prerequisite (one-time, manual): authorize the Slack workspace in the AWS
# Chatbot console, then keep var.slack_team_id set.

locals {
  enable_slack_alerts = var.slack_team_id != null
}

# IAM role AWS Chatbot assumes to read alarm context when rendering notifications.
resource "aws_iam_role" "chatbot_slack" {
  count = local.enable_slack_alerts ? 1 : 0
  name  = "${local.prefix}-chatbot-slack"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "ChatbotAssumeRole"
      Effect    = "Allow"
      Principal = { Service = "chatbot.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "chatbot_cloudwatch_read" {
  count      = local.enable_slack_alerts ? 1 : 0
  role       = aws_iam_role.chatbot_slack[0].name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchReadOnlyAccess"
}

resource "aws_chatbot_slack_channel_configuration" "alerts" {
  count = local.enable_slack_alerts ? 1 : 0

  configuration_name = "${local.prefix}-alerts"
  iam_role_arn       = aws_iam_role.chatbot_slack[0].arn
  slack_team_id      = var.slack_team_id
  slack_channel_id   = local.current_config.slack_channel_id
  sns_topic_arns     = [aws_sns_topic.alerts.arn]

  # Notification-only usage; cap any Slack-issued commands at read-only.
  guardrail_policy_arns = ["arn:aws:iam::aws:policy/CloudWatchReadOnlyAccess"]
  logging_level         = "ERROR"

  tags = local.common_tags
}
