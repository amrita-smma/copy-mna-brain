# Instance profile. Two grants only:
#   - AmazonSSMManagedInstanceCore, so `aws ssm start-session` is the shell and
#     port 22 can stay closed.
#   - Read on this environment's Redis parameters, so the boot script can
#     materialise the password and TLS files without them passing through
#     user_data.

resource "aws_iam_role" "instance" {
  name_prefix = "${local.name_prefix}-"
  description = "Redis EC2 instance role: SSM session access + its own secrets"

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
    sid    = "ReadRedisParameters"
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

resource "aws_iam_instance_profile" "instance" {
  name_prefix = "${local.name_prefix}-"
  role        = aws_iam_role.instance.name

  tags = local.environment_tags
}
