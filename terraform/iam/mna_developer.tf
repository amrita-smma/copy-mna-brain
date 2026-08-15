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

# Day-to-day group, now the only non-admin IAM group: absorbed mna_maintainers
# (which had zero members in every workspace) along with its full permission
# set, so no access is lost for anyone added to this group going forward.
# Deliberately narrower than mna_devops (AdministratorAccess) only in that it
# has no user/access-key management beyond what's listed below.
# Database login itself is not granted here — it comes from
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
        Sid    = "LambdaS3RdsAndFormerMaintainerAccess",
        Effect = "Allow",
        Action = [
          "lambda:*",
          "s3:*",
          "rds:*",
          "ec2:*",
          "elasticloadbalancing:*",
          "cloudwatch:*",
          "cloudshell:*",
          "ecs:*",
          "events:*",
          "iam:ListAttachedRolePolicies",
          "iam:ListInstanceProfiles",
          "iam:ListRoles",
          "logs:*",
          "backup:*",
          "textract:*",
          "iam:CreateUser",
          "iam:CreateAccessKey",
          "iam:CreatePolicy",
          "iam:GetPolicy",
          "iam:GetPolicyVersion",
          "iam:ListPolicyVersions",
          "iam:DeletePolicy",
          "iam:AttachUserPolicy",
          "iam:ListAttachedUserPolicies",
          "iam:DetachUserPolicy",
          "ses:SendEmail",
          "ses:SendRawEmail",
          "ssm:StartSession",
          "ssm:DescribeInstanceInformation",
          "ssm:TerminateSession",
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetTraceSummaries",
          "xray:BatchGetTraces",
          "xray:GetTraceGraph",
          "xray:GetServiceGraph",
          "tag:GetResources"
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
