resource "aws_codebuild_source_credential" "github" {
  auth_type   = "CODECONNECTIONS"
  server_type = "GITHUB"
  token       = var.codeconnections_arn
}

resource "aws_codebuild_project" "runner" {
  name          = local.project_name
  description   = "Ephemeral GitHub Actions self-hosted runner for ${var.github_repository}"
  service_role  = aws_iam_role.runner.arn
  build_timeout = 60

  source {
    type            = "GITHUB"
    location        = local.github_repo_url
    git_clone_depth = 1
    buildspec       = ""
  }

  environment {
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/standard:7.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = false
  }

  artifacts {
    type = "NO_ARTIFACTS"
  }

  logs_config {
    cloudwatch_logs {
      group_name = local.log_group_name
    }
  }

  tags = merge(local.common_tags, {
    Name = local.project_name
  })

  depends_on = [aws_codebuild_source_credential.github]
}
