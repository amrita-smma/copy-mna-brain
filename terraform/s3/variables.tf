variable "aws_region" {
  type    = string
  default = "ap-southeast-3"
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "cors_allowed_origins" {
  type        = list(string)
  default     = []
}

variable "cors_additional_origins" {
  type        = list(string)
  default     = []
}

data "aws_caller_identity" "current" {}

locals {
  workspace_config = {
    dev = {
      environment = "dev"
      tags = {
        Environment = "dev"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
    staging = {
      environment = "staging"
      tags = {
        Environment = "staging"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
    production = {
      environment = "production"
      tags = {
        Environment = "production"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
  }

  current_config   = lookup(local.workspace_config, terraform.workspace, local.workspace_config["dev"])
  environment_tags = merge(local.current_config.tags, var.tags)
  bucket_name      = "mna-app-data-${local.current_config.environment}"

  mna_cors_baseline = [
    "http://localhost:3000",
    "http://localhost:5173",
    "https://mna-stg.sqe.co.id",
    "https://mna.sqe.co.id",
    "https://*.vercel.app",
  ]

  s3_cors_allowed_origins = distinct(concat(
    local.mna_cors_baseline,
    var.cors_allowed_origins,
    var.cors_additional_origins,
  ))
}
