output "codebuild_project_name" {
  value = aws_codebuild_project.runner.name
}

output "codebuild_project_arn" {
  value = aws_codebuild_project.runner.arn
}

output "webhook_payload_url" {
  value = aws_codebuild_webhook.runner.payload_url
}

output "codebuild_runner_role_arn" {
  value = aws_iam_role.runner.arn
}

output "codebuild_runner_role_name" {
  value = aws_iam_role.runner.name
}

output "source_credential_arn" {
  value = aws_codebuild_source_credential.github.arn
}
