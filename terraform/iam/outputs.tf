output "mna_devops_user_names" {
  description = "Usernames added to mna_devops group (must exist in IAM)"
  value       = local.current_config.mna_devops_users
}

output "mna_maintainers_user_names" {
  description = "Usernames added to mna_maintainers group when not dev (must exist in IAM)"
  value       = local.current_config.mna_maintainers_users
}

output "rds_iam_db_connect_policy_arn_from_rds_state" {
  description = "Policy ARN from terraform/rds remote state (null if RDS not applied, IAM DB auth off, or attach_rds_iam_db_connect_policy=false)"
  value       = local.rds_iam_db_connect_policy_arn
}

output "rds_iam_db_connect_group_attachments_enabled" {
  description = "Whether mna_devops and mna_maintainers get the RDS IAM DB connect policy attachment (non-dev only)"
  value = (
    var.attach_rds_iam_db_connect_policy &&
    local.environment != "dev" &&
    local.rds_iam_db_connect_policy_arn != null
  )
}

output "additional_iam_roles_with_rds_db_connect" {
  description = "IAM role names that received aws_iam_role_policy_attachment for rds-db:connect (from variable additional_iam_role_names_for_rds_db_connect)"
  value       = tolist(local.extra_iam_roles_for_rds_connect)
}

output "dbeaver_rds_iam_auth_cli" {
  description = "Copy-paste: generate an auth token for DBeaver (password field) with SSL required. Each engineer uses their own AWS credentials (profile or env). Token expires ~15 minutes."
  value = (
    local.rds_db_endpoint_for_cli != null &&
    local.rds_db_port_for_cli != null &&
    local.rds_iam_db_username_for_cli != null
    ) ? join("\n", [
      "# 1) Ensure AWS CLI v2 and credentials for an identity that has rds-db:connect (mna_devops / mna_maintainers group, or an attached SSO role).",
      "# 2) Generate token (paste entire output as DBeaver password; no spaces/newlines if DBeaver complains):",
      "aws rds generate-db-auth-token \\",
      "  --hostname ${local.rds_db_endpoint_for_cli} \\",
      "  --port ${local.rds_db_port_for_cli} \\",
      "  --region ${var.aws_region} \\",
      "  --username ${local.rds_iam_db_username_for_cli}",
      "",
      "# Optional named profile:",
      "aws rds generate-db-auth-token \\",
      "  --hostname ${local.rds_db_endpoint_for_cli} \\",
      "  --port ${local.rds_db_port_for_cli} \\",
      "  --region ${var.aws_region} \\",
      "  --username ${local.rds_iam_db_username_for_cli} \\",
      "  --profile YOUR_PROFILE",
      "",
      "# DBeaver: host=${local.rds_db_endpoint_for_cli} port=${local.rds_db_port_for_cli} database=mna user=${local.rds_iam_db_username_for_cli} SSL=require",
      "# Run bootstrap SQL from terraform/rds output iam_db_auth_bootstrap_sql once if user ${local.rds_iam_db_username_for_cli} is new.",
  ]) : "(Set attach_rds_iam_db_connect_policy=true and apply terraform/rds in this workspace to populate endpoint/port/username.)"
}
