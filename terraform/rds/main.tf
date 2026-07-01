locals {
  rds_subnet_ids = var.rds_publicly_accessible ? (
    data.terraform_remote_state.vpc.outputs.public_subnet_id
    ) : (
    data.terraform_remote_state.vpc.outputs.private_subnet_id
  )
}

resource "random_password" "master" {
  length           = 24
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_db_subnet_group" "private" {
  name       = "mna-${local.current_config.environment}-rds-private"
  subnet_ids = local.rds_subnet_ids

  tags = merge(local.environment_tags, {
    Name = "mna-${local.current_config.environment}-rds-private"
  })
}

# NOTE: rules are declared as standalone aws_security_group_rule resources
# below, NOT as inline ingress/egress blocks. This is deliberate: other modules
# (e.g. data-pipeline/terraform/pipeline-compute) attach their own
# aws_security_group_rule to this SG via remote state. Inline blocks make
# Terraform treat this config as the full desired rule set and revoke any rule
# it didn't declare — which would delete those cross-module rules on every
# apply. The AWS provider requires all-or-nothing per SG: with no inline blocks,
# rule ownership is left entirely to the standalone resources.
resource "aws_security_group" "rds" {
  name_prefix = "mna-${local.current_config.environment}-rds-"
  description = "PostgreSQL from VPC CIDR and optional internet when public"
  vpc_id      = data.terraform_remote_state.vpc.outputs.vpc_id

  tags = merge(local.environment_tags, {
    Name = "mna-${local.current_config.environment}-rds-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "rds_from_vpc" {
  type              = "ingress"
  description       = "PostgreSQL from VPC CIDR"
  from_port         = 5432
  to_port           = 5432
  protocol          = "tcp"
  cidr_blocks       = [data.terraform_remote_state.vpc.outputs.vpc_cidr_block]
  security_group_id = aws_security_group.rds.id
}

resource "aws_security_group_rule" "rds_from_internet" {
  for_each = var.rds_publicly_accessible ? toset(var.rds_public_ingress_cidrs) : toset([])

  type              = "ingress"
  description       = "PostgreSQL from internet (TLS required via rds.force_ssl)"
  from_port         = 5432
  to_port           = 5432
  protocol          = "tcp"
  cidr_blocks       = [each.value]
  security_group_id = aws_security_group.rds.id
}

resource "aws_security_group_rule" "rds_egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.rds.id
}

resource "aws_db_instance" "mna" {
  identifier = "mna-${local.current_config.environment}-postgres"

  engine               = "postgres"
  engine_version       = "16"
  instance_class       = local.rds_instance_class
  allocated_storage    = local.rds_allocated_storage
  storage_type         = "gp3"
  storage_encrypted    = true
  db_subnet_group_name = aws_db_subnet_group.private.name

  parameter_group_name = aws_db_parameter_group.mna_postgres.name

  db_name  = var.db_name
  username = var.db_username
  password = random_password.master.result

  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = var.rds_publicly_accessible
  multi_az               = local.rds_multi_az

  apply_immediately = local.rds_apply_immediately

  iam_database_authentication_enabled = local.rds_iam_db_auth_enabled

  backup_retention_period   = local.rds_backup_retention_period
  backup_window             = "18:00-19:00"
  maintenance_window        = "sun:19:00-sun:20:00"
  skip_final_snapshot       = false
  final_snapshot_identifier = "mna-${local.current_config.environment}-tf-${substr(sha256(join(",", sort(local.rds_subnet_ids))), 0, 16)}"

  copy_tags_to_snapshot = true

  tags = merge(local.environment_tags, {
    Name = "mna-${local.current_config.environment}-postgres"
  })

  lifecycle {
    ignore_changes = [
      password,
      engine_version
    ]
    replace_triggered_by = [
      aws_db_subnet_group.private.subnet_ids
    ]
  }
}

resource "aws_ssm_parameter" "db_master_password" {
  name        = "/mna/${local.current_config.environment}/rds/master-password"
  description = "RDS master password (set by Terraform; rotate outside TF)"
  type        = "SecureString"
  value       = random_password.master.result

  tags = local.environment_tags

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "db_master_connection" {
  name = "/mna/${local.current_config.environment}/rds/connection"
  type = "String"
  value = jsonencode({
    host                 = aws_db_instance.mna.address
    port                 = aws_db_instance.mna.port
    dbname               = var.db_name
    username             = var.db_username
    publiclyAccessible   = aws_db_instance.mna.publicly_accessible
    useTls               = true
    rdsForceSslParameter = true
    rdsTlsCaBundleUrl    = local.rds_global_tls_ca_bundle_url
    iamDbAuthEnabled     = local.rds_iam_db_auth_enabled
    iamDbAuthUsername    = var.iam_db_auth_username
    notes                = "Master auth: SSM master-password. IAM DB auth: use CLI generate-db-auth-token as password for iamDbAuthUsername (~15m TTL); run bootstrap SQL once (terraform output iam_db_auth_bootstrap_sql). TLS: download rdsTlsCaBundleUrl for verify-full."
  })

  tags = local.environment_tags
}
