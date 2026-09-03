variable "aws_region" {
  description = "AWS region for the RSS lake bucket."
  type        = string
  default     = "ap-southeast-3"
}

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
  bucket_name    = "mna-${local.environment}-rss-lake"

  common_tags = {
    Project     = "mna"
    Environment = local.environment
    ManagedBy   = "terraform"
    Component   = "rss-lake"
  }
}
