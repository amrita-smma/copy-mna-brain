variable "aws_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "github_repository" {
  type    = string
  default = "sqeai/mna-brain"
}

variable "codeconnections_arn" {
  type      = string
  sensitive = true
}

data "aws_caller_identity" "current" {}

locals {
  workspace_config = {
    staging = {
      environment = "staging"
      tags = {
        Environment = "staging"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
  }

  current_config   = local.workspace_config[terraform.workspace]
  environment      = local.current_config.environment
  common_tags      = merge(local.current_config.tags, var.tags)
  project_name     = "mna-brain-runner"
  github_repo_url  = "https://github.com/${var.github_repository}.git"
  log_group_name   = "/aws/codebuild/${local.project_name}"
}
