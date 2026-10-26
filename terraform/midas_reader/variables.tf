variable "aws_region" {
  type    = string
  default = "ap-southeast-3"
}

variable "iam_user_name" {
  description = "Existing IAM user Star Capital's Midas authenticates as. Created by hand in each account; Terraform only attaches the rds-db:connect policy."
  type        = string
  default     = "midas.reader"
}

variable "db_username" {
  description = "PostgreSQL user Midas logs in as. Must match the role created by the midas_data_mart migration."
  type        = string
  default     = "midas_reader"
}

data "aws_caller_identity" "current" {}

locals {
  workspace_config = {
    staging = {
      environment = "staging"
    }
    production = {
      environment = "production"
    }
  }

  current_config = lookup(local.workspace_config, terraform.workspace, local.workspace_config["staging"])
  environment    = local.current_config.environment
}
