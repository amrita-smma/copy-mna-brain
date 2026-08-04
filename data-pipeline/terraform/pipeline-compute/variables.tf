variable "aws_region" {
  type    = string
  default = "ap-southeast-3"
}

variable "tags" {
  type    = map(string)
  default = {}
}

# Lambda config
variable "lambda_memory_mb" {
  description = "Default Lambda memory in MB (network + gzip CPU scale with memory)"
  type        = number
  default     = 1024
}

variable "lambda_memory_mb_heavy" {
  description = "Memory for transfer-heavy functions (vaultArchivePoll)"
  type        = number
  default     = 3008
}

variable "lambda_timeout_seconds" {
  type    = number
  default = 600
}

# Alert email for CloudWatch alarm notifications
variable "alarm_email" {
  description = "Email address to notify on Lambda error alarms"
  type        = string
  default     = "kensen.huang@sqe.co.id"
}

# AWS Chatbot -> Slack alerting. The per-workspace channel is resolved from
# local.current_config.slack_channel_id (see workspace_config below). Set
# slack_team_id to null to disable Slack alerting entirely.
variable "slack_team_id" {
  description = "Slack workspace (team) ID for AWS Chatbot. Requires a one-time Slack workspace authorization in the AWS Chatbot console. Set to null to skip Slack alerting."
  type        = string
  default     = "T03MDGSH7QE"
}

# RDS IAM auth
variable "rds_db_username" {
  description = "DB username the Lambda role will authenticate as via RDS IAM"
  type        = string
  default     = "mna_iam"
}

variable "github_repository" {
  description = "GitHub repository allowed to deploy pipeline Lambda code via OIDC, in owner/repo form."
  type        = string
  default     = "sqeai/mna-brain"
}

variable "github_oidc_repository_subject" {
  description = "ID-qualified GitHub OIDC repository subject. GitHub may use this form after a repository rename."
  type        = string
  default     = "sqeai@201060396/mna-brain@1138955955"
}

variable "github_oidc_provider_arn" {
  description = "Existing GitHub Actions OIDC provider ARN. Leave null to create one in this state."
  type        = string
  default     = null
}

data "aws_caller_identity" "current" {}

locals {
  workspace_config = {
    staging = {
      environment      = "staging"
      slack_channel_id = "C0BG0HR1KSQ" # #mna-brain-alerts-staging
      tags = {
        Environment = "staging"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
    production = {
      environment      = "production"
      slack_channel_id = "C0BFWNGM4SW" # #mna-brain-alerts-production
      tags = {
        Environment = "production"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
  }

  current_config = lookup(local.workspace_config, terraform.workspace, local.workspace_config["staging"])
  tfstate_bucket = "mna-tfstate-${local.current_config.environment}-${data.aws_caller_identity.current.account_id}"
  environment    = local.current_config.environment
  common_tags    = merge(local.current_config.tags, var.tags)
  prefix         = "mna-${local.environment}-pipeline"
}
