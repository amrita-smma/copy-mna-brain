variable "aws_region" {
  type    = string
  default = "ap-southeast-3"
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "db_name" {
  type    = string
  default = "mna"
}

variable "db_username" {
  type    = string
  default = "mnaapp"
}

variable "rds_publicly_accessible" {
  description = "When true, RDS uses public subnets only in the DB subnet group so the ENI has an Internet Gateway route (required for internet clients like DBeaver). When false, only private subnets are used."
  type        = bool
  default     = true
}

variable "rds_public_ingress_cidrs" {
  description = "IPv4 CIDRs allowed to reach RDS on 5432 from the internet when rds_publicly_accessible is true. Use narrow /32 lists (e.g. Vercel Static IPs) when possible."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "rds_iam_database_authentication_enabled" {
  description = "When true, enables RDS IAM DB authentication (password + IAM). Workspaces staging and production always use true (see local.rds_iam_db_auth_enabled). Dev falls back to this variable."
  type        = bool
  default     = true
}

variable "iam_db_auth_username" {
  description = "PostgreSQL role name used only for IAM DB auth (must match --username when generating the token). Do not use the RDS master user unless you intend IAM to take precedence over password for that user."
  type        = string
  default     = "mna_iam"
}

variable "iam_db_auth_attach_users" {
  description = "Optional: attach rds-db:connect policy directly to these IAM usernames. Prefer attaching via terraform/iam (mna_devops + mna_developer groups) using remote state; leave empty when using that path."
  type        = list(string)
  default     = []
}

variable "iam_db_auth_attach_roles" {
  description = "IAM role names to attach the rds-db:connect policy to (e.g. app task role)."
  type        = list(string)
  default     = []
}

variable "create_vercel_rds_iam_db_user" {
  description = "When true (and RDS IAM DB auth is enabled), create an IAM user scoped only for rds-db:connect. Put a one-time access key in Vercel as AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (create key outside Terraform to keep secrets out of tfstate)."
  type        = bool
  default     = true
}

variable "vercel_rds_iam_user_name" {
  description = "Override IAM username for Vercel; default mna-<env>-vercel-rds-iam"
  type        = string
  default     = null
  nullable    = true
}

data "aws_caller_identity" "current" {}

locals {
  tfstate_bucket = "mna-tfstate-${terraform.workspace}-${data.aws_caller_identity.current.account_id}"

  # Per-environment configuration. Instance sizing, storage, HA and backup
  # settings live here so staging vs production differences are declared in one
  # place rather than as flat variables/inline expressions.
  workspace_config = {
    dev = {
      environment                             = "dev"
      rds_iam_database_authentication_enabled = var.rds_iam_database_authentication_enabled
      rds_apply_immediately                   = true
      instance_class                          = "db.t3.micro"
      allocated_storage                       = 20
      multi_az                                = false
      backup_retention_period                 = 7
      tags = {
        Environment = "dev"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
    staging = {
      environment                             = "staging"
      rds_iam_database_authentication_enabled = true
      rds_apply_immediately                   = true
      instance_class                          = "db.t3.micro"
      allocated_storage                       = 20
      multi_az                                = false
      backup_retention_period                 = 7
      tags = {
        Environment = "staging"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
    production = {
      environment                             = "production"
      rds_iam_database_authentication_enabled = true
      # Safer default: defer instance changes to maintenance window unless you reboot or use -var.
      rds_apply_immediately   = false
      instance_class          = "db.t3.small"
      allocated_storage       = 100
      multi_az                = true
      backup_retention_period = 7
      tags = {
        Environment = "production"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
  }

  current_config              = lookup(local.workspace_config, terraform.workspace, local.workspace_config["dev"])
  environment_tags            = merge(local.current_config.tags, var.tags)
  rds_iam_db_auth_enabled     = local.current_config.rds_iam_database_authentication_enabled
  rds_apply_immediately       = local.current_config.rds_apply_immediately
  rds_instance_class          = local.current_config.instance_class
  rds_allocated_storage       = local.current_config.allocated_storage
  rds_multi_az                = local.current_config.multi_az
  rds_backup_retention_period = local.current_config.backup_retention_period

  # Official RDS global CA bundle (download into your app or CI; too large for SSM).
  rds_global_tls_ca_bundle_url = "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem"
}

data "terraform_remote_state" "vpc" {
  backend = "s3"
  config = {
    bucket = local.tfstate_bucket
    key    = "env:/${terraform.workspace}/mna/vpc"
    region = var.aws_region
  }
}
