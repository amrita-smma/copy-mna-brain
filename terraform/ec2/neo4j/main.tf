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

# Securely generate the Neo4j admin password. Stored in Terraform state (keep
# the state backend encrypted/locked). Retrieve with `terraform output -raw neo4j_password`.
# The instance is reachable on a public IP, so the password is the primary line
# of defense. Generate a long, high-entropy secret. Retrieve it with
# `terraform output -raw neo4j_password`.
resource "random_password" "neo4j" {
  length           = 32
  special          = false
  min_lower        = 4
  min_upper        = 4
  min_numeric      = 4
}

resource "aws_iam_role" "neo4j_server" {
  name = "${local.current_config.environment}-mna-neo4j-server-role"

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

resource "aws_iam_role_policy" "neo4j_server_custom" {
  name = "${local.current_config.environment}-mna-neo4j-server-custom-policy"
  role = aws_iam_role.neo4j_server.id

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

resource "aws_iam_instance_profile" "neo4j_server" {
  name = "${local.current_config.environment}-mna-neo4j-server-profile"
  role = aws_iam_role.neo4j_server.name

  tags = local.environment_tags
}

locals {
  # The instance has a public IP and is reached directly over the internet.
  # Default to open access (auth is enforced by the strong Neo4j password);
  # callers can restrict this with var.allowed_cidr_blocks.
  neo4j_ingress_cidrs = length(var.allowed_cidr_blocks) > 0 ? var.allowed_cidr_blocks : ["0.0.0.0/0"]
}

resource "aws_security_group" "neo4j_server" {
  name        = "${local.current_config.environment}-mna-neo4j-server-sg"
  description = "Security group for MnA Neo4j server - public Bolt/HTTP from allowed CIDRs"
  vpc_id      = data.terraform_remote_state.vpc.outputs.vpc_id

  ingress {
    description = "Neo4j HTTP browser"
    from_port   = var.neo4j_http_port
    to_port     = var.neo4j_http_port
    protocol    = "tcp"
    cidr_blocks = local.neo4j_ingress_cidrs
  }

  ingress {
    description = "Neo4j Bolt protocol"
    from_port   = var.neo4j_bolt_port
    to_port     = var.neo4j_bolt_port
    protocol    = "tcp"
    cidr_blocks = local.neo4j_ingress_cidrs
  }

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
    Name   = "${local.current_config.environment}-mna-neo4j-server-sg"
    Type   = "Neo4jServer"
    Access = "Public"
  })
}

resource "aws_instance" "neo4j_server" {
  ami                         = data.aws_ami.ubuntu_22.id
  instance_type               = var.instance_type
  subnet_id                   = data.terraform_remote_state.vpc.outputs.public_subnet_id[0]
  vpc_security_group_ids      = [aws_security_group.neo4j_server.id]
  iam_instance_profile        = aws_iam_instance_profile.neo4j_server.name
  associate_public_ip_address = true

  lifecycle {
    ignore_changes = [ami]
  }

  user_data_replace_on_change = true
  user_data_base64 = base64encode(replace(templatefile("${path.module}/templates/user_data.sh", {
    neo4j_version   = var.neo4j_version
    neo4j_username  = var.neo4j_username
    neo4j_password  = random_password.neo4j.result
    neo4j_http_port = var.neo4j_http_port
    neo4j_bolt_port = var.neo4j_bolt_port
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
    aws_iam_role_policy.neo4j_server_custom
  ]

  tags = merge(local.environment_tags, {
    Name   = "${local.current_config.environment}-mna-neo4j-server"
    Type   = "Neo4jServer"
    Access = "Public"
  })
}

resource "aws_cloudwatch_log_group" "neo4j_server" {
  name              = "/neo4j/${local.current_config.environment}/mna/server"
  retention_in_days = 30

  tags = local.environment_tags
}
