resource "aws_iam_group" "mna_developer" {
  count = local.environment == "dev" ? 0 : 1
  name  = "mna_developer"
}

resource "aws_iam_group_membership" "mna_developer" {
  count = local.environment == "dev" ? 0 : 1
  name  = "mna_developer_membership"
  group = aws_iam_group.mna_developer[0].name
  users = local.current_config.mna_developer_users
}

# Least-privilege day-to-day group: Lambda, S3 and RDS only. Deliberately narrower
# than mna_maintainers (no ec2/ecs/iam/backup/ssm) and than mna_devops
# (AdministratorAccess). Database login itself is not granted here — it comes from
# the rds-db:connect attachment in rds_iam_db_connect.tf, because rds:* does not
# cover the rds-db service prefix used by RDS IAM authentication.
resource "aws_iam_group_policy" "mna_developer_policy" {
  count = local.environment == "dev" ? 0 : 1
  name  = "mna_developer_policy"
  group = aws_iam_group.mna_developer[0].name
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid    = "LambdaS3Rds",
        Effect = "Allow",
        Action = [
          "lambda:*",
          "s3:*",
          "rds:*"
        ],
        Resource = "*"
      },
      {
        # Terraform state holds secrets in plaintext (the RDS master password among
        # them), and s3:* would also allow corrupting or deleting state objects.
        # Deny beats Allow in IAM, so this carve-out survives the wildcard above.
        Sid    = "DenyTerraformState",
        Effect = "Deny",
        Action = "s3:*",
        Resource = [
          "arn:aws:s3:::mna-tfstate-*",
          "arn:aws:s3:::mna-tfstate-*/*"
        ]
      }
    ]
  })
}
