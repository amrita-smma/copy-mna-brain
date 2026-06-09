# Lambda execution role
resource "aws_iam_role" "pipeline_lambda" {
  name = "${local.prefix}-lambda-exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "LambdaAssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

# Basic Lambda execution (CloudWatch Logs)
resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.pipeline_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# RDS IAM auth — rds-db:connect as the configured DB user
resource "aws_iam_policy" "rds_iam_connect" {
  name        = "${local.prefix}-rds-iam-connect"
  description = "Allow pipeline Lambdas to authenticate to RDS via IAM as ${var.rds_db_username}"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "RdsIamDbConnect"
      Effect   = "Allow"
      Action   = ["rds-db:connect"]
      Resource = "arn:aws:rds-db:${var.aws_region}:${data.aws_caller_identity.current.account_id}:dbuser:${data.aws_db_instance.mna.resource_id}/${var.rds_db_username}"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "rds_iam_connect" {
  role       = aws_iam_role.pipeline_lambda.name
  policy_arn = aws_iam_policy.rds_iam_connect.arn
}

# S3 RW on the data-lake bucket (mbox archives)
resource "aws_iam_role_policy_attachment" "data_lake_rw" {
  role       = aws_iam_role.pipeline_lambda.name
  policy_arn = aws_iam_policy.data_lake_rw.arn
}

# SSM Parameter Store — read pipeline secrets
resource "aws_iam_policy" "ssm_read" {
  name        = "${local.prefix}-ssm-read"
  description = "Allow pipeline Lambdas to read SSM parameters under /mna/${local.environment}/pipeline/"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "SsmGetParameters"
      Effect = "Allow"
      Action = [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
      ]
      Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/mna/${local.environment}/pipeline*"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ssm_read" {
  role       = aws_iam_role.pipeline_lambda.name
  policy_arn = aws_iam_policy.ssm_read.arn
}

# SQS SendMessage — for DLQs
resource "aws_iam_policy" "dlq_send" {
  name        = "${local.prefix}-dlq-send"
  description = "Allow pipeline Lambdas to send failed events to their DLQs"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "SqsSendMessage"
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = values(module.pipeline_lambdas.dlq_arns)
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "dlq_send" {
  role       = aws_iam_role.pipeline_lambda.name
  policy_arn = aws_iam_policy.dlq_send.arn
}
