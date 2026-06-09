locals {
  github_oidc_provider_arn = var.github_oidc_provider_arn != null ? var.github_oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.github_oidc_provider_arn == null ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = local.common_tags
}

resource "aws_iam_role" "github_actions_lambda_deploy" {
  name        = "${local.prefix}-github-lambda-deploy"
  description = "GitHub Actions role for code-only deploys to ${local.environment} pipeline Lambdas"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "GitHubActionsOidcAssumeRole"
      Effect = "Allow"
      Principal = {
        Federated = local.github_oidc_provider_arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:ref:refs/heads/main"
        }
      }
    }]
  })

  tags = merge(local.common_tags, {
    GitHubRepository = var.github_repository
    DeployScope      = "pipeline-lambda-code"
  })
}

resource "aws_iam_policy" "github_actions_lambda_deploy" {
  name        = "${local.prefix}-github-lambda-deploy"
  description = "Allow GitHub Actions to update code for existing ${local.environment} pipeline Lambdas"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "UpdateExistingPipelineLambdaCode"
        Effect = "Allow"
        Action = [
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:ListVersionsByFunction",
          "lambda:UpdateFunctionCode",
        ]
        Resource = values(module.pipeline_lambdas.lambda_function_arns)
      },
    ]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "github_actions_lambda_deploy" {
  role       = aws_iam_role.github_actions_lambda_deploy.name
  policy_arn = aws_iam_policy.github_actions_lambda_deploy.arn
}
