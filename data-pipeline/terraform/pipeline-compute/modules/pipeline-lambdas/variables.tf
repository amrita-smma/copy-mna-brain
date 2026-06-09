variable "lambda_configs" {
  description = "Pipeline Lambda definitions keyed by deploy name."
  type = map(object({
    handler      = string
    schedule     = string
    description  = string
    memory_heavy = bool
    input        = string
  }))
}

variable "prefix" {
  description = "Name prefix for pipeline resources."
  type        = string
}

variable "common_tags" {
  description = "Tags applied to Lambda resources."
  type        = map(string)
}

variable "lambda_role_arn" {
  description = "Execution role ARN used by the pipeline Lambdas."
  type        = string
}

variable "lambda_security_group_id" {
  description = "Security group attached to all pipeline Lambdas."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for the pipeline Lambdas."
  type        = list(string)
}

variable "lambda_env" {
  description = "Environment variables injected into every Lambda."
  type        = map(string)
}

variable "lambda_timeout_seconds" {
  description = "Lambda timeout in seconds."
  type        = number
}

variable "lambda_memory_mb" {
  description = "Default Lambda memory in MB."
  type        = number
}

variable "lambda_memory_mb_heavy" {
  description = "Memory for transfer-heavy Lambda functions."
  type        = number
}

variable "alerts_topic_arn" {
  description = "SNS topic ARN for Lambda error alarms."
  type        = string
}
