# Pipeline secrets in SSM Parameter Store.
# Values are managed outside Terraform (set via AWS Console or CLI) to avoid
# storing secrets in state. Terraform only declares the parameter shells.

resource "aws_ssm_parameter" "anthropic_api_key" {
  name        = "/mna/${local.environment}/pipeline/ANTHROPIC_API_KEY"
  description = "Anthropic API key for crm-llm-submit and crm-domain-classify"
  type        = "SecureString"
  value       = "PLACEHOLDER — set via AWS Console or CLI before first Lambda run"
  lifecycle {
    ignore_changes = [value]
  }
  tags = local.common_tags
}

resource "aws_ssm_parameter" "google_vault_service_account" {
  name        = "/mna/${local.environment}/pipeline/GOOGLE_VAULT_SERVICE_ACCOUNT"
  description = "Google Vault service account JSON for vault-archive handlers"
  type        = "SecureString"
  value       = "PLACEHOLDER — set via AWS Console or CLI before first Lambda run"
  lifecycle {
    ignore_changes = [value]
  }
  tags = local.common_tags
}

resource "aws_ssm_parameter" "admin_secret" {
  name        = "/mna/${local.environment}/pipeline/ADMIN_SECRET"
  description = "Shared internal API secret for attachment-upload server-to-server calls"
  type        = "SecureString"
  value       = "PLACEHOLDER — set via AWS Console or CLI before first attachment-upload run"
  lifecycle {
    ignore_changes = [value]
  }
  tags = local.common_tags
}

resource "aws_ssm_parameter" "internal_api_url" {
  name        = "/mna/${local.environment}/pipeline/INTERNAL_API_URL"
  description = "Base URL for the deployed app, used by attachment-upload to call AI File Dump"
  type        = "String"
  value       = "PLACEHOLDER — set to the deployed app URL before first attachment-upload run"
  lifecycle {
    ignore_changes = [value]
  }
  tags = local.common_tags
}

resource "aws_ssm_parameter" "db_host" {
  name        = "/mna/${local.environment}/pipeline/DB_HOST"
  description = "RDS endpoint for pipeline Lambdas"
  type        = "String"
  value       = data.terraform_remote_state.rds.outputs.db_endpoint
  tags        = local.common_tags
}

resource "aws_ssm_parameter" "db_name" {
  name        = "/mna/${local.environment}/pipeline/DB_NAME"
  description = "RDS database name"
  type        = "String"
  value       = "mna"
  tags        = local.common_tags
}

resource "aws_ssm_parameter" "db_user" {
  name        = "/mna/${local.environment}/pipeline/DB_USER"
  description = "RDS IAM auth username for pipeline Lambdas"
  type        = "String"
  value       = var.rds_db_username
  tags        = local.common_tags
}

