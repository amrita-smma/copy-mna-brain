variable "aws_region" {
  type    = string
  default = "ap-southeast-3"
}

variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_caller_identity" "current" {}

locals {
  workspace_config = {
    staging = {
      environment   = "staging"
      domain        = "mna-stg.sqe.co.id"
      noreply_email = "noreply@mna-stg.sqe.co.id"
      tags = {
        Environment = "staging"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
    production = {
      environment   = "production"
      domain        = "mna.sqe.co.id"
      noreply_email = "noreply@mna.sqe.co.id"
      tags = {
        Environment = "production"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
  }

  current_config   = lookup(local.workspace_config, terraform.workspace, local.workspace_config["staging"])
  environment_tags = merge(local.current_config.tags, var.tags)
}
