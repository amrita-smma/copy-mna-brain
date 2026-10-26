# Midas (Star Capital) data mart access.
#
# Star Capital assumes this IAM role from their own AWS account and uses it to
# generate an RDS IAM auth token for the Postgres user `midas_reader`. That
# user can log in only with an IAM token and can read only the `midas` schema
# of views over the fund ledger (migration 20261026000003_midas_data_mart.sql).
#
# The role grants rds-db:connect for that one DB user and nothing else. It is
# created only when midas_trusted_principal_arns is non-empty and IAM DB auth
# is on.

variable "midas_db_username" {
  description = "PostgreSQL user Midas logs in as. Must match the role created by the midas_data_mart migration."
  type        = string
  default     = "midas_reader"
}

variable "midas_trusted_principal_arns" {
  description = <<-EOT
    IAM principals in Star Capital's AWS account allowed to assume the Midas
    role, e.g. ["arn:aws:iam::123456789012:role/midas-agent"]. Use an account
    root ARN (arn:aws:iam::<id>:root) only if Star Capital will delegate it
    further on their side. Empty = no role is created.
  EOT
  type        = list(string)
  default     = []
}

variable "midas_external_id" {
  description = "sts:ExternalId Star Capital must send when assuming the role (protects against the confused-deputy problem). Agree on it out of band; null disables the condition."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}

locals {
  midas_role_enabled = local.rds_iam_db_auth_enabled && length(var.midas_trusted_principal_arns) > 0

  midas_db_connect_arn = (
    "arn:aws:rds-db:${var.aws_region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_db_instance.mna.resource_id}/${var.midas_db_username}"
  )
}

data "aws_iam_policy_document" "midas_assume_role" {
  count = local.midas_role_enabled ? 1 : 0

  statement {
    sid     = "StarCapitalAssumeRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = var.midas_trusted_principal_arns
    }

    dynamic "condition" {
      for_each = var.midas_external_id == null ? [] : [var.midas_external_id]
      content {
        test     = "StringEquals"
        variable = "sts:ExternalId"
        values   = [condition.value]
      }
    }
  }
}

resource "aws_iam_role" "midas_rds_reader" {
  count = local.midas_role_enabled ? 1 : 0

  name                 = "mna-${local.current_config.environment}-midas-rds-reader"
  description          = "Star Capital Midas: RDS IAM auth as ${var.midas_db_username} (read-only midas data mart)"
  assume_role_policy   = data.aws_iam_policy_document.midas_assume_role[0].json
  max_session_duration = 3600

  tags = merge(local.environment_tags, {
    Name    = "mna-${local.current_config.environment}-midas-rds-reader"
    Purpose = "Midas data mart: rds-db:connect as ${var.midas_db_username} only"
  })
}

resource "aws_iam_role_policy" "midas_rds_db_connect" {
  count = local.midas_role_enabled ? 1 : 0

  name = "rds-db-connect-${var.midas_db_username}"
  role = aws_iam_role.midas_rds_reader[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RdsIamDbConnectMidasReader"
        Effect   = "Allow"
        Action   = ["rds-db:connect"]
        Resource = local.midas_db_connect_arn
      }
    ]
  })
}

output "midas_rds_reader_role_arn" {
  description = "Give this to Star Capital: the role they assume to generate RDS IAM auth tokens for the Midas data mart"
  value       = local.midas_role_enabled ? aws_iam_role.midas_rds_reader[0].arn : null
}

output "midas_db_username" {
  description = "PostgreSQL user for the Midas data mart (token goes in the password field)"
  value       = var.midas_db_username
}

output "midas_generate_db_auth_token_cli" {
  description = "Run with credentials from the assumed Midas role; the printed token is the password (valid 15 minutes, SSL required)"
  value       = "aws rds generate-db-auth-token --hostname ${aws_db_instance.mna.address} --port ${aws_db_instance.mna.port} --region ${var.aws_region} --username ${var.midas_db_username}"
}

output "midas_reader_bootstrap_sql" {
  description = "Run once as the RDS master user if the migration could not create or grant midas_reader (it logs a NOTICE when it skips)"
  value       = <<-EOT
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${var.midas_db_username}') THEN
        CREATE ROLE ${var.midas_db_username} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 5;
      END IF;
    END $$;
    GRANT rds_iam TO ${var.midas_db_username};
    GRANT CONNECT ON DATABASE ${var.db_name} TO ${var.midas_db_username};
    GRANT USAGE ON SCHEMA midas TO ${var.midas_db_username};
    GRANT SELECT ON ALL TABLES IN SCHEMA midas TO ${var.midas_db_username};
    ALTER ROLE ${var.midas_db_username} SET search_path = midas;
    ALTER ROLE ${var.midas_db_username} SET default_transaction_read_only = on;
    ALTER ROLE ${var.midas_db_username} SET statement_timeout = '60s';
    ALTER ROLE ${var.midas_db_username} SET idle_in_transaction_session_timeout = '60s';
  EOT
}
