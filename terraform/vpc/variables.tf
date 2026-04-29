variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-southeast-3"
}

variable "availability_zones" {
  description = "AZs for the VPC (two subnets per tier)"
  type        = list(string)
  default     = ["ap-southeast-3a", "ap-southeast-3b"]
}

variable "tags" {
  description = "Additional tags merged into workspace defaults"
  type        = map(string)
  default     = {}
}

locals {
  # Naming: mna-{env}-vpc, CIDR mna-{octet} per env (see CONVENTIONS in repo docs — pattern mna-<workspace>-*)
  workspace_config = {
    dev = {
      name            = "mna-dev"
      cidr_block      = "10.100.0.0/16"
      public_subnets  = ["10.100.1.0/24", "10.100.2.0/24"]
      private_subnets = ["10.100.3.0/24", "10.100.4.0/24"]
      environment     = "dev"
      tags = {
        Environment = "dev"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
    staging = {
      name            = "mna-staging"
      cidr_block      = "10.101.0.0/16"
      public_subnets  = ["10.101.1.0/24", "10.101.2.0/24"]
      private_subnets = ["10.101.3.0/24", "10.101.4.0/24"]
      environment     = "staging"
      tags = {
        Environment = "staging"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
    production = {
      name            = "mna-production"
      cidr_block      = "10.102.0.0/16"
      public_subnets  = ["10.102.1.0/24", "10.102.2.0/24"]
      private_subnets = ["10.102.3.0/24", "10.102.4.0/24"]
      environment     = "production"
      tags = {
        Environment = "production"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
  }

  current_config = lookup(local.workspace_config, terraform.workspace, local.workspace_config["dev"])
  vpc_config = {
    name            = local.current_config.name
    cidr_block      = local.current_config.cidr_block
    public_subnets  = local.current_config.public_subnets
    private_subnets = local.current_config.private_subnets
    environment     = local.current_config.environment
  }
  all_tags = merge(local.current_config.tags, var.tags)
}

variable "vpc" {
  description = "Optional full override of VPC CIDR and subnet layout"
  type = object({
    name            = string
    cidr_block      = string
    public_subnets  = list(string)
    private_subnets = list(string)
    environment     = string
  })
  default = null
}
