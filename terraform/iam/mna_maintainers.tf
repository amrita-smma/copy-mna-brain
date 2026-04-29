resource "aws_iam_group" "mna_maintainers" {
  count = local.environment == "dev" ? 0 : 1
  name  = "mna_maintainers"
}

resource "aws_iam_group_membership" "mna_maintainers" {
  count = local.environment == "dev" ? 0 : 1
  name  = "mna_maintainers_membership"
  group = aws_iam_group.mna_maintainers[0].name
  users = local.current_config.mna_maintainers_users
}

resource "aws_iam_group_policy" "mna_maintainer_policy" {
  count = local.environment == "dev" ? 0 : 1
  name  = "mna_maintainer_policy"
  group = aws_iam_group.mna_maintainers[0].name
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
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
          "rds:*",
          "ec2:*",
          "s3:*",
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
      }
    ]
  })
}
