locals {
  # First public subnet. Public is required: the Elastic IP needs an Internet
  # Gateway route for Let's Encrypt to reach Caddy on port 80.
  subnet_id = data.terraform_remote_state.vpc.outputs.public_subnet_id[0]

  # On Nitro instances EBS volumes present as /dev/nvme*n1 in attach order, so
  # the device_name below is only a hint. This by-id symlink is stable and is
  # what the boot script actually formats and mounts.
  data_device = "/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${replace(aws_ebs_volume.data.id, "-", "")}"

  compose_file = templatefile("${path.module}/templates/docker-compose.yml.tftpl", {
    langfuse_image_tag  = var.langfuse_image_tag
    clickhouse_image    = var.clickhouse_image
    redis_image         = var.redis_image
    postgres_image      = var.postgres_image
    caddy_image         = var.caddy_image
    clickhouse_heap     = local.current_config.clickhouse_heap
    blob_bucket         = aws_s3_bucket.blob.bucket
    aws_region          = var.aws_region
    auth_disable_signup = var.disable_signup
  })

  caddyfile = templatefile("${path.module}/templates/Caddyfile.tftpl", {
    hostname   = local.hostname
    acme_email = var.acme_email
  })

  user_data = templatefile("${path.module}/templates/user_data.sh.tftpl", {
    aws_region      = var.aws_region
    ssm_prefix      = local.ssm_prefix
    data_device     = local.data_device
    hostname        = local.hostname
    environment     = local.environment
    init_user_email = var.init_user_email
    init_user_name  = var.init_user_name
    compose_file    = local.compose_file
    caddyfile       = local.caddyfile
  })
}

# Rules are standalone aws_security_group_rule resources rather than inline
# ingress/egress blocks, matching terraform/rds: inline blocks make Terraform
# treat this config as the complete rule set and revoke anything another module
# attached to the SG.
resource "aws_security_group" "langfuse" {
  name_prefix = "${local.name_prefix}-"
  description = "Langfuse: HTTP/HTTPS from the internet, optional break-glass SSH"
  vpc_id      = data.terraform_remote_state.vpc.outputs.vpc_id

  tags = merge(local.environment_tags, {
    Name = "${local.name_prefix}-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# Port 80 is not redundant with 443: Caddy serves the ACME HTTP-01 challenge
# there and redirects everything else, so closing it breaks certificate renewal.
resource "aws_security_group_rule" "http" {
  for_each = toset(var.https_ingress_cidrs)

  type              = "ingress"
  description       = "HTTP: ACME HTTP-01 challenge and redirect to HTTPS"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  cidr_blocks       = [each.value]
  security_group_id = aws_security_group.langfuse.id
}

resource "aws_security_group_rule" "https" {
  for_each = toset(var.https_ingress_cidrs)

  type              = "ingress"
  description       = "HTTPS: Langfuse UI and ingestion API"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = [each.value]
  security_group_id = aws_security_group.langfuse.id
}

resource "aws_security_group_rule" "ssh" {
  for_each = toset(var.ssh_ingress_cidrs)

  type              = "ingress"
  description       = "Break-glass SSH: prefer SSM Session Manager"
  from_port         = 22
  to_port           = 22
  protocol          = "tcp"
  cidr_blocks       = [each.value]
  security_group_id = aws_security_group.langfuse.id
}

resource "aws_security_group_rule" "egress" {
  type              = "egress"
  description       = "All egress: image pulls, ACME, SSM"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.langfuse.id
}

# Trace data lives on its own volume, not the root disk, so replacing the
# instance (which any user_data change does) keeps the history.
resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_subnet.selected.availability_zone
  size              = local.current_config.data_volume_gb
  type              = "gp3"
  encrypted         = true

  tags = merge(local.environment_tags, {
    Name = "${local.name_prefix}-data"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_instance" "langfuse" {
  ami                  = data.aws_ssm_parameter.al2023_ami.value
  instance_type        = local.current_config.instance_type
  subnet_id            = local.subnet_id
  iam_instance_profile = aws_iam_instance_profile.instance.name
  key_name             = var.key_pair_name

  vpc_security_group_ids = [aws_security_group.langfuse.id]

  # The Elastic IP below is the address DNS points at. A public IP on the ENI is
  # still needed for the instance to reach the internet before the EIP
  # associates (image pulls, SSM registration).
  associate_public_ip_address = true

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 30
    encrypted             = true
    delete_on_termination = true
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required" # IMDSv2 only
  }

  # gzip'd: the rendered script embeds the whole compose file and Caddyfile and
  # runs close to EC2's 16 KB user-data ceiling uncompressed. cloud-init
  # transparently decompresses.
  user_data_base64            = base64gzip(local.user_data)
  user_data_replace_on_change = true

  tags = merge(local.environment_tags, {
    Name = "${local.name_prefix}"
  })

  lifecycle {
    # A new Amazon Linux release must not silently replace the box on an
    # unrelated apply. Bump deliberately by tainting the instance.
    ignore_changes = [ami]
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.langfuse.id

  # Without this a `terraform destroy` (or an instance replacement) can hang
  # waiting on a volume the OS still has mounted.
  stop_instance_before_detaching = true
}

resource "aws_eip" "langfuse" {
  domain = "vpc"

  tags = merge(local.environment_tags, {
    Name = "${local.name_prefix}-eip"
  })
}

resource "aws_eip_association" "langfuse" {
  instance_id   = aws_instance.langfuse.id
  allocation_id = aws_eip.langfuse.id
}
