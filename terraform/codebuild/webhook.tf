resource "aws_codebuild_webhook" "runner" {
  project_name = aws_codebuild_project.runner.name
  build_type   = "BUILD"

  filter_group {
    filter {
      type    = "EVENT"
      pattern = "WORKFLOW_JOB_QUEUED"
    }
  }
}
