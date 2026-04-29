
locals {
  rds_iam_db_connect_arn = local.rds_iam_db_auth_enabled ? (
    "arn:aws:rds-db:${var.aws_region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_db_instance.mna.resource_id}/${var.iam_db_auth_username}"
  ) : ""
}

resource "aws_iam_policy" "rds_iam_db_connect" {
  count = local.rds_iam_db_auth_enabled ? 1 : 0

  name        = "mna-${local.current_config.environment}-rds-iam-db-connect-${var.iam_db_auth_username}"
  description = "Allow rds-db:connect for IAM database authentication to ${aws_db_instance.mna.identifier} as ${var.iam_db_auth_username}"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RdsIamDbConnect"
        Effect   = "Allow"
        Action   = ["rds-db:connect"]
        Resource = local.rds_iam_db_connect_arn
      }
    ]
  })

  tags = local.environment_tags
}

resource "aws_iam_user_policy_attachment" "rds_iam_db_connect" {
  for_each = local.rds_iam_db_auth_enabled ? toset(var.iam_db_auth_attach_users) : toset([])

  user       = each.value
  policy_arn = aws_iam_policy.rds_iam_db_connect[0].arn
}

resource "aws_iam_role_policy_attachment" "rds_iam_db_connect" {
  for_each = local.rds_iam_db_auth_enabled ? toset(var.iam_db_auth_attach_roles) : toset([])

  role       = each.value
  policy_arn = aws_iam_policy.rds_iam_db_connect[0].arn
}
