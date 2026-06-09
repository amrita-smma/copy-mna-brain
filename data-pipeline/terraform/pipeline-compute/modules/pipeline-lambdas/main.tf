# DLQ (one per function)
resource "aws_sqs_queue" "dlq" {
  for_each = var.lambda_configs

  name                      = "${var.prefix}-${each.key}-dlq"
  message_retention_seconds = 1209600 # 14 days
  tags                      = var.common_tags
}

# Lambda functions
resource "aws_lambda_function" "pipeline" {
  for_each = var.lambda_configs

  function_name = "${var.prefix}-${each.key}"
  description   = each.value.description
  role          = var.lambda_role_arn

  # Bundles are built by `pnpm --filter data-pipeline build`. Terraform creates
  # each function from the current local zip, then GitHub Actions owns normal
  # code-only deployments through lambda:UpdateFunctionCode.
  filename         = "${path.root}/../../dist/${each.key}.zip"
  source_code_hash = filebase64sha256("${path.root}/../../dist/${each.key}.zip")
  handler          = "index.handler"
  runtime          = "nodejs20.x"

  timeout     = var.lambda_timeout_seconds
  memory_size = each.value.memory_heavy ? var.lambda_memory_mb_heavy : var.lambda_memory_mb

  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [var.lambda_security_group_id]
  }

  dead_letter_config {
    target_arn = aws_sqs_queue.dlq[each.key].arn
  }

  environment {
    variables = var.lambda_env
  }

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
  }

  tags = var.common_tags
}

# EventBridge rules + targets
resource "aws_cloudwatch_event_rule" "schedule" {
  for_each = var.lambda_configs

  name                = "${var.prefix}-${each.key}"
  description         = "Trigger ${each.key} pipeline Lambda"
  schedule_expression = each.value.schedule

  tags = var.common_tags
}

resource "aws_cloudwatch_event_target" "lambda" {
  for_each = var.lambda_configs

  rule      = aws_cloudwatch_event_rule.schedule[each.key].name
  target_id = "${var.prefix}-${each.key}"
  arn       = aws_lambda_function.pipeline[each.key].arn
  input     = each.value.input
}

# EventBridge needs permission to invoke each Lambda.
resource "aws_lambda_permission" "eventbridge" {
  for_each = var.lambda_configs

  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.pipeline[each.key].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.schedule[each.key].arn
}

# CloudWatch alarms -> SNS
resource "aws_cloudwatch_metric_alarm" "errors" {
  for_each = var.lambda_configs

  alarm_name          = "${var.prefix}-${each.key}-errors"
  alarm_description   = "Pipeline Lambda ${each.key} threw an error"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.pipeline[each.key].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  tags = var.common_tags
}
