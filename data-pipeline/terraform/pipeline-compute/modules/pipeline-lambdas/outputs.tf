output "lambda_function_arns" {
  description = "ARNs of all pipeline Lambda functions."
  value       = { for k, fn in aws_lambda_function.pipeline : k => fn.arn }
}

output "lambda_function_names" {
  description = "Names of all pipeline Lambda functions."
  value       = { for k, fn in aws_lambda_function.pipeline : k => fn.function_name }
}

output "dlq_urls" {
  description = "SQS DLQ URLs per function."
  value       = { for k, q in aws_sqs_queue.dlq : k => q.url }
}

output "dlq_arns" {
  description = "SQS DLQ ARNs per function."
  value       = { for k, q in aws_sqs_queue.dlq : k => q.arn }
}
