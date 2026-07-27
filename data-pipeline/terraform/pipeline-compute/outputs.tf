output "lambda_function_arns" {
  description = "ARNs of all pipeline Lambda functions"
  value       = module.pipeline_lambdas.lambda_function_arns
}

output "lambda_function_names" {
  description = "Names of all pipeline Lambda functions"
  value       = module.pipeline_lambdas.lambda_function_names
}

output "dlq_urls" {
  description = "SQS DLQ URLs per function"
  value       = module.pipeline_lambdas.dlq_urls
}

output "dlq_arns" {
  description = "SQS DLQ ARNs per function"
  value       = module.pipeline_lambdas.dlq_arns
}

output "lambda_security_group_id" {
  description = "Security group attached to all pipeline Lambdas"
  value       = aws_security_group.pipeline_lambda.id
}

output "lambda_role_arn" {
  description = "IAM execution role ARN shared by all pipeline Lambdas"
  value       = aws_iam_role.pipeline_lambda.arn
}

output "alerts_topic_arn" {
  description = "SNS topic ARN for pipeline Lambda error alerts"
  value       = aws_sns_topic.alerts.arn
}

output "ssm_prefix" {
  description = "SSM parameter path prefix for pipeline secrets"
  value       = "/mna/${local.environment}/pipeline"
}

output "github_actions_lambda_deploy_role_arn" {
  description = "GitHub Actions OIDC role ARN for code-only pipeline Lambda deploys"
  value       = aws_iam_role.github_actions_lambda_deploy.arn
}

output "slack_alerts_channel_configuration_arn" {
  description = "ARN of the AWS Chatbot Slack channel configuration for alarm alerts (null when Slack alerting is disabled)"
  value       = local.enable_slack_alerts ? aws_chatbot_slack_channel_configuration.alerts[0].chat_configuration_arn : null
}
