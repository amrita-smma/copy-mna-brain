# Remote state from SES module
data "terraform_remote_state" "ses" {
  backend = "s3"
  config = {
    bucket = local.tfstate_bucket
    key    = "env:/${local.environment}/mna/ses"
    region = "ap-southeast-3"
  }
}

# IAM Policy for S3 Full Access
resource "aws_iam_policy" "mna_files_s3_policy" {
  name        = "mna-files-s3-policy"
  description = "Full S3 access for mna-app"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "S3FullAccess"
        Effect   = "Allow"
        Action   = "s3:*"
        Resource = "*"
      }
    ]
  })

  tags = local.common_tags
}

# IAM Role for S3 Access (can be assumed by EC2, Lambda, etc.)
resource "aws_iam_role" "mna_files_role" {
  name        = "mna-files-role"
  description = "Role for accessing mna-files S3 bucket"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = [
            "ec2.amazonaws.com",
            "lambda.amazonaws.com"
          ]
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = local.common_tags
}

# Attach policy to role
resource "aws_iam_role_policy_attachment" "mna_files_role_attachment" {
  role       = aws_iam_role.mna_files_role.name
  policy_arn = aws_iam_policy.mna_files_s3_policy.arn
}

# IAM User for programmatic access
resource "aws_iam_user" "mna_files_user" {
  name = "mna-app"
  path = "/mna/"

  tags = local.common_tags
}

# Attach S3 policy to user
resource "aws_iam_user_policy_attachment" "mna_files_user_attachment" {
  user       = aws_iam_user.mna_files_user.name
  policy_arn = aws_iam_policy.mna_files_s3_policy.arn
}

# Attach SES send-email policy to user
resource "aws_iam_user_policy_attachment" "mna_files_user_ses_attachment" {
  user       = aws_iam_user.mna_files_user.name
  policy_arn = data.terraform_remote_state.ses.outputs.ses_send_email_policy_arn
}

# Attach RDS full access to user
resource "aws_iam_user_policy_attachment" "mna_files_user_rds_attachment" {
  user       = aws_iam_user.mna_files_user.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonRDSFullAccess"
}

# Bedrock — the app embeds Data Navigator search queries in-process via
# `BedrockEmbeddingClient` (src/lib/bedrock.ts), constructed in
# `createContainer` and in the `search_news` agent tool. Without this the
# embed call fails, `DataNavigatorService.vectorHalf` swallows the error and
# returns [], and hybrid search silently degrades to trigram-only. Scoped to
# the single embedding model, mirroring the pipeline Lambdas' policy in
# data-pipeline/terraform/pipeline-compute/iam.tf.
resource "aws_iam_policy" "bedrock_invoke_app" {
  name        = "mna-app-bedrock-invoke"
  description = "Allow the mna-app user to invoke the Bedrock embedding model for search query embeddings"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "InvokeEmbeddingModel"
      Effect   = "Allow"
      Action   = ["bedrock:InvokeModel"]
      Resource = "arn:aws:bedrock:${var.bedrock_region}::foundation-model/${var.bedrock_embedding_model}"
    }]
  })

  tags = local.common_tags
}

# Attach Bedrock invoke policy to user
resource "aws_iam_user_policy_attachment" "mna_files_user_bedrock_attachment" {
  user       = aws_iam_user.mna_files_user.name
  policy_arn = aws_iam_policy.bedrock_invoke_app.arn
}
