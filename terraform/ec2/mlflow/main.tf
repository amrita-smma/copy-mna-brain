provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

data "terraform_remote_state" "vpc" {
  backend   = "s3"
  workspace = local.current_config.environment
  config = {
    bucket = "mna-tfstate-${local.current_config.environment}-${data.aws_caller_identity.current.account_id}"
    key    = "mna/vpc"
    region = var.aws_region
  }
}

data "aws_ami" "ubuntu_22" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_iam_role" "mlflow_server" {
  name = "${local.current_config.environment}-mna-mlflow-server-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = local.environment_tags
}

resource "aws_iam_role_policy_attachment" "mlflow_ssm_core" {
  role       = aws_iam_role.mlflow_server.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "mlflow_server_custom" {
  name = "${local.current_config.environment}-mna-mlflow-server-custom-policy"
  role = aws_iam_role.mlflow_server.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "mlflow_server" {
  name = "${local.current_config.environment}-mna-mlflow-server-profile"
  role = aws_iam_role.mlflow_server.name

  tags = local.environment_tags
}

resource "aws_security_group" "mlflow_server" {
  name        = "${local.current_config.environment}-mna-mlflow-server-sg"
  description = "Security group for MnA MLflow server - SSM access only"
  vpc_id      = data.terraform_remote_state.vpc.outputs.vpc_id

  egress {
    description = "HTTPS outbound"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "HTTP for package updates"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "DNS"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.environment_tags, {
    Name   = "${local.current_config.environment}-mna-mlflow-server-sg"
    Type   = "MLflowServer"
    Access = "SSMOnly"
  })
}

resource "aws_instance" "mlflow_server" {
  ami                         = data.aws_ami.ubuntu_22.id
  instance_type               = var.instance_type
  subnet_id                   = data.terraform_remote_state.vpc.outputs.private_subnet_id[0]
  vpc_security_group_ids      = [aws_security_group.mlflow_server.id]
  iam_instance_profile        = aws_iam_instance_profile.mlflow_server.name
  associate_public_ip_address = false

  lifecycle {
    ignore_changes = [ami]
  }

  user_data_replace_on_change = true
  user_data_base64 = base64encode(replace(templatefile("${path.module}/templates/user_data.sh", {
    python_version     = var.python_version
    mlflow_version     = var.mlflow_version
    mlflow_workers     = var.mlflow_workers
    mlflow_port        = var.mlflow_port
    artifact_root_path = var.artifact_root_path
    backend_store_path = var.backend_store_path
    enable_traces      = var.enable_traces
    otlp_endpoint      = var.otlp_endpoint
    otlp_headers       = var.otlp_headers
    otlp_protocol      = var.otlp_protocol
  }), "\r\n", "\n"))

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.ebs_volume_size
    delete_on_termination = true
    encrypted             = true
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  depends_on = [
    aws_iam_role_policy_attachment.mlflow_ssm_core,
    aws_iam_role_policy.mlflow_server_custom
  ]

  tags = merge(local.environment_tags, {
    Name   = "${local.current_config.environment}-mna-mlflow-server"
    Type   = "MLflowServer"
    Access = "SSMOnly"
  })
}

resource "aws_cloudwatch_log_group" "mlflow_server" {
  name              = "/mlflow/${local.current_config.environment}/mna/server"
  retention_in_days = 30

  tags = local.environment_tags
}
