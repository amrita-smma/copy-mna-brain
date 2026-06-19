locals {
  workspace_config = {
    staging = {
      name        = "staging"
      environment = "staging"
      tags = {
        Environment = "staging"
        Project     = "MnA"
        Service     = "Neo4j"
        ManagedBy   = "Terraform"
      }
    }
    production = {
      name        = "production"
      environment = "production"
      tags = {
        Environment = "production"
        Project     = "MnA"
        Service     = "Neo4j"
        ManagedBy   = "Terraform"
      }
    }
  }

  current_config   = lookup(local.workspace_config, terraform.workspace, local.workspace_config["staging"])
  environment_tags = merge(local.current_config.tags, var.tags)
}

resource "terraform_data" "workspace_guard" {
  lifecycle {
    precondition {
      condition     = contains(["staging", "production"], terraform.workspace)
      error_message = "This module can only be applied in 'staging' or 'production' workspace. Current workspace: '${terraform.workspace}'."
    }
  }
}

variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "ap-southeast-3"
}

variable "instance_type" {
  description = "EC2 instance type for the Neo4j server"
  type        = string
  default     = "t3.medium"
}

variable "ebs_volume_size" {
  description = "EBS volume size in GB for root and database storage"
  type        = number
  default     = 50
}

variable "neo4j_version" {
  description = "Neo4j version to install (Debian package version, e.g. 5.26.0). Empty installs the latest available."
  type        = string
  default     = "5.26.0"
}

variable "neo4j_username" {
  description = "Neo4j admin username. Neo4j ships with a built-in 'neo4j' superuser; changing this provisions an additional admin role."
  type        = string
  default     = "mnabrainneo4j"

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9_]{2,31}$", var.neo4j_username))
    error_message = "neo4j_username must start with a letter and contain only letters, digits, or underscores (3-32 chars)."
  }
}

variable "neo4j_http_port" {
  description = "Port for the Neo4j HTTP browser interface"
  type        = number
  default     = 7474

  validation {
    condition     = var.neo4j_http_port > 0 && var.neo4j_http_port < 65536
    error_message = "neo4j_http_port must be a valid TCP port (1-65535)."
  }
}

variable "neo4j_bolt_port" {
  description = "Port for the Neo4j Bolt protocol (driver connections)"
  type        = number
  default     = 7687

  validation {
    condition     = var.neo4j_bolt_port > 0 && var.neo4j_bolt_port < 65536
    error_message = "neo4j_bolt_port must be a valid TCP port (1-65535)."
  }
}

variable "allowed_cidr_blocks" {
  description = "CIDR blocks allowed to reach the Neo4j HTTP/Bolt ports. Defaults to 0.0.0.0/0 (open to the internet); access is protected by the strong Neo4j password. Set this to restrict to known IPs."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Additional tags to apply to resources"
  type        = map(string)
  default = {
    ManagedBy = "Terraform"
  }
}
