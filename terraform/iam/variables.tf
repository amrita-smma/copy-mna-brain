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
  tfstate_bucket = "mna-tfstate-${terraform.workspace}-${data.aws_caller_identity.current.account_id}"

  workspace_config = {
    dev = {
      environment           = "dev"
      mna_devops_users      = ["haris.prakoso", "nico.alimin"]
      mna_maintainers_users = []
      tags = {
        Environment = "dev"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
    staging = {
      environment = "staging"
      mna_devops_users = [
        "haris.prakoso",
        "nico.alimin",
      ]
      mna_maintainers_users = [
        "dicki.sujadi",
        "kensen.huang",
      ]
      tags = {
        Environment = "staging"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
    production = {
      environment = "production"
      mna_devops_users = [
        "haris.prakoso",
        "nico.alimin",
      ]
      mna_maintainers_users = []
      tags = {
        Environment = "production"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
  }

  current_config = lookup(local.workspace_config, terraform.workspace, local.workspace_config["dev"])
  environment    = local.current_config.environment
  common_tags    = merge(local.current_config.tags, var.tags)
}
