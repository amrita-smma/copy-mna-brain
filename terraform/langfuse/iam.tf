# Instance profile. Three grants only:
#   - AmazonSSMManagedInstanceCore, so `aws ssm start-session` is the shell and
#     port 22 can stay closed.
#   - Read on this environment's Langfuse parameters, so the boot script can
#     materialise the container secrets without them passing through user_data.
#   - Read/write on its own blob bucket. This is what lets the compose file omit
#     LANGFUSE_S3_*_ACCESS_KEY_ID entirely: Langfuse leaves credentials
#     undefined and the AWS SDK picks up this role from the instance metadata,
#     so there is no static key pair anywhere in the system.

resource "aws_iam_role" "instance" {
  name_prefix = "${local.name_prefix}-"
  description = "Langfuse EC2 instance role: SSM session access + its own secrets"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.environment_tags
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "read_secrets" {
  statement {
    sid    = "ReadLangfuseParameters"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = [
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}",
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/*",
    ]
  }
}

resource "aws_iam_role_policy" "read_secrets" {
  name_prefix = "${local.name_prefix}-secrets-"
  role        = aws_iam_role.instance.id
  policy      = data.aws_iam_policy_document.read_secrets.json
}

data "aws_iam_policy_document" "blob_bucket" {
  statement {
    sid       = "ListLangfuseBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.blob.arn]
  }

  statement {
    sid    = "ReadWriteLangfuseObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.blob.arn}/*"]
  }
}

resource "aws_iam_role_policy" "blob_bucket" {
  name_prefix = "${local.name_prefix}-s3-"
  role        = aws_iam_role.instance.id
  policy      = data.aws_iam_policy_document.blob_bucket.json
}

resource "aws_iam_instance_profile" "instance" {
  name_prefix = "${local.name_prefix}-"
  role        = aws_iam_role.instance.name

  tags = local.environment_tags
}
