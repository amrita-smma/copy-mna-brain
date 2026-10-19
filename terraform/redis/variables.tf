variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-southeast-3"
}

variable "tags" {
  description = "Additional tags merged into workspace defaults"
  type        = map(string)
  default     = {}
}

variable "redis_image" {
  description = "Redis image. Pin to a major (\"7\") or an exact version."
  type        = string
  default     = "redis:7"
}

variable "redis_maxmemory" {
  description = <<-EOT
    Redis `maxmemory`. The app stores only live, expiring state here (bot
    presence, stop signals, pub/sub fan-out), so this stays small; with
    `noeviction` a full store refuses writes rather than silently dropping keys.
  EOT
  type        = string
  default     = "256mb"
}

variable "redis_ingress_cidrs" {
  description = <<-EOT
    IPv4 CIDRs allowed to reach the TLS Redis port (6379). Must include
    0.0.0.0/0 unless you know every egress IP of the clients: Vercel functions
    have no stable outbound IPs unless the project is on Secure Compute. The
    plaintext port is disabled entirely, and every connection needs the
    generated password, so the network rule is the outer layer, not the only one.
  EOT
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "ssh_ingress_cidrs" {
  description = <<-EOT
    IPv4 CIDRs allowed to reach port 22. Empty by default: the instance profile
    grants AWS Systems Manager, so `aws ssm start-session` is the intended shell
    and no SSH port needs to be open. Only populate this for break-glass access.
  EOT
  type        = list(string)
  default     = []
}

variable "key_pair_name" {
  description = "Optional EC2 key pair for break-glass SSH. Leave null to rely on SSM Session Manager."
  type        = string
  default     = null
  nullable    = true
}

data "aws_caller_identity" "current" {}

locals {
  tfstate_bucket = "mna-tfstate-${terraform.workspace}-${data.aws_caller_identity.current.account_id}"

  # One container holding a few hundred small keys: the smallest burstable
  # class is plenty everywhere. Memory is bounded by redis_maxmemory, not by
  # the box.
  workspace_config = {
    dev = {
      environment   = "dev"
      instance_type = "t3.small"
      tags = {
        Environment = "dev"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
    staging = {
      environment   = "staging"
      instance_type = "t3.small"
      tags = {
        Environment = "staging"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
    production = {
      environment   = "production"
      instance_type = "t3.small"
      tags = {
        Environment = "production"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
  }

  current_config = lookup(local.workspace_config, terraform.workspace, local.workspace_config["dev"])
  environment    = local.current_config.environment
  name_prefix    = "mna-${local.environment}-redis"

  environment_tags = merge(local.current_config.tags, {
    Component = "redis"
  }, var.tags)
}
