locals {
  vercel_rds_iam_user_name = coalesce(
    var.vercel_rds_iam_user_name,
    "mna-${local.current_config.environment}-vercel-rds-iam"
  )
}

resource "aws_iam_user" "vercel_rds_iam" {
  count = local.rds_iam_db_auth_enabled && var.create_vercel_rds_iam_db_user ? 1 : 0

  name = local.vercel_rds_iam_user_name
  path = "/mna/vercel/"

  tags = merge(local.environment_tags, {
    Name        = local.vercel_rds_iam_user_name
    Purpose     = "Vercel serverless: RDS IAM DB auth token signing only"
    Environment = local.current_config.environment
  })
}

resource "aws_iam_user_policy_attachment" "vercel_rds_iam_db_connect" {
  count = local.rds_iam_db_auth_enabled && var.create_vercel_rds_iam_db_user ? 1 : 0

  user       = aws_iam_user.vercel_rds_iam[0].name
  policy_arn = aws_iam_policy.rds_iam_db_connect[0].arn
}
