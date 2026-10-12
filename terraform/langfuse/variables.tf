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

variable "langfuse_image_tag" {
  description = "Tag for langfuse/langfuse and langfuse/langfuse-worker. Pin to a major (\"3\") or an exact version."
  type        = string
  default     = "3"
}

variable "clickhouse_image" {
  description = "ClickHouse server image for the Langfuse OLAP store"
  type        = string
  default     = "clickhouse/clickhouse-server:24.3"
}

variable "redis_image" {
  description = "Redis image for the Langfuse ingestion queue"
  type        = string
  default     = "redis:7"
}

variable "postgres_image" {
  description = "Postgres image for the Langfuse transactional store"
  type        = string
  default     = "postgres:16"
}

variable "caddy_image" {
  description = "Caddy image terminating TLS in front of langfuse-web"
  type        = string
  default     = "caddy:2"
}

variable "event_retention_days" {
  description = <<-EOT
    How long raw ingestion event payloads are kept in the S3 blob bucket. These
    are a replay/debug buffer; the queryable traces live in ClickHouse on the
    instance and are unaffected by this.
  EOT
  type        = number
  default     = 30
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

variable "https_ingress_cidrs" {
  description = <<-EOT
    IPv4 CIDRs allowed to reach ports 80 and 443. Must include 0.0.0.0/0 unless
    you know every egress IP of the clients that send traces: Vercel functions
    do not have stable outbound IPs unless the project is on Secure Compute, and
    port 80 must stay reachable from anywhere for the Let's Encrypt HTTP-01
    challenge to succeed.
  EOT
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "key_pair_name" {
  description = "Optional EC2 key pair for break-glass SSH. Leave null to rely on SSM Session Manager."
  type        = string
  default     = null
  nullable    = true
}

variable "acme_email" {
  description = "Contact address Let's Encrypt uses for expiry notices on the Caddy-issued certificate"
  type        = string
  default     = "devops@sqe.co.id"
}

variable "init_user_email" {
  description = "Email of the Langfuse user seeded on first boot (LANGFUSE_INIT_USER_EMAIL)"
  type        = string
  default     = "devops@sqe.co.id"
}

variable "init_user_name" {
  description = "Display name of the seeded Langfuse user"
  type        = string
  default     = "MnA DevOps"
}

data "aws_caller_identity" "current" {}

locals {
  tfstate_bucket = "mna-tfstate-${terraform.workspace}-${data.aws_caller_identity.current.account_id}"

  # Per-environment sizing and hostname. Langfuse runs five containers plus
  # ClickHouse, which is the memory floor here — ClickHouse alone wants ~2 GiB
  # before it starts spilling, and langfuse-web takes ~900 MB on its own. A
  # t3.small (2 GiB) OOM-killed langfuse-web on first boot, so t3.medium is the
  # smallest staging box; production gets headroom for retention-window queries.
  workspace_config = {
    dev = {
      environment     = "dev"
      hostname        = "langfuse-dev.sqe.co.id"
      instance_type   = "t3.medium"
      data_volume_gb  = 50
      clickhouse_heap = "1500000000"
      tags = {
        Environment = "dev"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
    staging = {
      environment = "staging"
      # The Elastic IP: staging runs without a DNS record, on a Let's Encrypt
      # IP certificate. Swap in a DNS name here once one points at it.
      hostname        = "15.232.210.57"
      instance_type   = "t3.medium"
      data_volume_gb  = 50
      clickhouse_heap = "1500000000"
      tags = {
        Environment = "staging"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
    production = {
      environment = "production"
      # The Elastic IP, as on staging: no DNS record, a Let's Encrypt IP
      # certificate. Swap in a DNS name here once one points at it.
      hostname        = "15.232.114.39"
      instance_type   = "t3.large"
      data_volume_gb  = 200
      clickhouse_heap = "4000000000"
      tags = {
        Environment = "production"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
  }

  current_config = lookup(local.workspace_config, terraform.workspace, local.workspace_config["dev"])
  environment    = local.current_config.environment
  name_prefix    = "mna-${local.environment}-langfuse"
  hostname       = coalesce(var.hostname, local.current_config.hostname)

  environment_tags = merge(local.current_config.tags, {
    Component = "langfuse"
  }, var.tags)
}

variable "hostname" {
  description = "Override the public hostname Caddy requests a certificate for. Defaults to the per-workspace value. May be the instance's Elastic IP, to run without a DNS record."
  type        = string
  default     = null
  nullable    = true
}
