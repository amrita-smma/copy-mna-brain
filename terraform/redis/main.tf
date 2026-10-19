locals {
  # First public subnet: the app on Vercel reaches the box over the internet.
  subnet_id = data.terraform_remote_state.vpc.outputs.public_subnet_id[0]

  compose_file = templatefile("${path.module}/templates/docker-compose.yml.tftpl", {
    redis_image     = var.redis_image
    redis_maxmemory = var.redis_maxmemory
  })

  user_data = templatefile("${path.module}/templates/user_data.sh.tftpl", {
    aws_region   = var.aws_region
    ssm_prefix   = local.ssm_prefix
    environment  = local.environment
    compose_file = local.compose_file
  })
}

# Rules are standalone aws_security_group_rule resources rather than inline
# ingress/egress blocks, matching terraform/rds: inline blocks make Terraform
# treat this config as the complete rule set and revoke anything another module
# attached to the SG.
resource "aws_security_group" "redis" {
  name_prefix = "${local.name_prefix}-"
  description = "App Redis: TLS 6379 from the internet, optional break-glass SSH"
  vpc_id      = data.terraform_remote_state.vpc.outputs.vpc_id

  tags = merge(local.environment_tags, {
    Name = "${local.name_prefix}-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "redis" {
  for_each = toset(var.redis_ingress_cidrs)

  type              = "ingress"
  description       = "Redis over TLS (the plaintext port is disabled in the container)"
  from_port         = 6379
  to_port           = 6379
  protocol          = "tcp"
  cidr_blocks       = [each.value]
  security_group_id = aws_security_group.redis.id
}

resource "aws_security_group_rule" "ssh" {
  for_each = toset(var.ssh_ingress_cidrs)

  type              = "ingress"
  description       = "Break-glass SSH: prefer SSM Session Manager"
  from_port         = 22
  to_port           = 22
  protocol          = "tcp"
  cidr_blocks       = [each.value]
  security_group_id = aws_security_group.redis.id
}

resource "aws_security_group_rule" "egress" {
  type              = "egress"
  description       = "All egress: image pulls, SSM"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.redis.id
}

# No data volume: the app keeps only live, expiring state here (presence,
# stop signals, pub/sub), and the container runs with persistence off. An
# instance replacement starts empty, which is correct — a bot's "thinking"
# marker from before the replacement is stale by definition.
resource "aws_instance" "redis" {
  ami                  = data.aws_ssm_parameter.al2023_ami.value
  instance_type        = local.current_config.instance_type
  subnet_id            = local.subnet_id
  iam_instance_profile = aws_iam_instance_profile.instance.name
  key_name             = var.key_pair_name

  vpc_security_group_ids = [aws_security_group.redis.id]

  # The Elastic IP below is the address in REDIS_URL. A public IP on the ENI
  # is still needed for the instance to reach the internet before the EIP
  # associates (image pull, SSM registration).
  associate_public_ip_address = true

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 20
    encrypted             = true
    delete_on_termination = true
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required" # IMDSv2 only
  }

  # gzip'd like terraform/langfuse: the rendered script embeds the compose
  # file; cloud-init transparently decompresses.
  user_data_base64            = base64gzip(local.user_data)
  user_data_replace_on_change = true

  # The boot script reads every parameter, so they must exist first.
  depends_on = [aws_ssm_parameter.redis]

  tags = merge(local.environment_tags, {
    Name = "${local.name_prefix}"
  })

  lifecycle {
    # A new Amazon Linux release must not silently replace the box on an
    # unrelated apply. Bump deliberately by tainting the instance.
    ignore_changes = [ami]
  }
}

# Created before the instance and the server certificate: the certificate's
# only SAN is this address.
resource "aws_eip" "redis" {
  domain = "vpc"

  tags = merge(local.environment_tags, {
    Name = "${local.name_prefix}-eip"
  })
}

resource "aws_eip_association" "redis" {
  instance_id   = aws_instance.redis.id
  allocation_id = aws_eip.redis.id
}
