variable "lambda_configs" {
  description = "Pipeline Lambda definitions keyed by deploy name."
  type = map(object({
    handler              = string
    schedule             = string
    description          = string
    memory_heavy         = bool
    input                = string
    ephemeral_storage_mb = optional(number, 512)
    # The Errors alarm fires when `datapoints_to_alarm` of the last
    # `evaluation_periods` windows of `period_seconds` each saw an error.
    # Defaults: 3 of the last 4 quarter-hours, so a transient failure that
    # the next scheduled run recovers from stays quiet and a sustained one
    # (a crash loop) alarms once and stays in ALARM until it clears.
    error_alarm = optional(object({
      period_seconds      = optional(number, 900)
      evaluation_periods  = optional(number, 4)
      datapoints_to_alarm = optional(number, 3)
      # Function-specific advice appended to the alarm description.
      hint = optional(string, "")
    }), {})
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
