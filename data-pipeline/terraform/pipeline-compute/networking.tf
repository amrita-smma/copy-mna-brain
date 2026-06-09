# Security group for pipeline Lambdas
resource "aws_security_group" "pipeline_lambda" {
  name        = "${local.prefix}-lambda-sg"
  description = "Pipeline Lambda egress: RDS, NAT (Anthropic/Google Vault), S3 endpoint"
  vpc_id      = data.terraform_remote_state.vpc.outputs.vpc_id

  # Egress to RDS on 5432
  egress {
    description     = "RDS PostgreSQL"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [data.terraform_remote_state.rds.outputs.rds_security_group_id]
  }

  # Egress HTTPS — Anthropic API, Google Vault API, S3 via NAT/gateway endpoint
  egress {
    description = "HTTPS egress (Anthropic, Google Vault, S3)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${local.prefix}-lambda-sg" })
}

# Allow Lambda SG to reach RDS SG
resource "aws_security_group_rule" "rds_allow_pipeline_lambda" {
  type                     = "ingress"
  description              = "Pipeline Lambda to RDS"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = data.terraform_remote_state.rds.outputs.rds_security_group_id
  source_security_group_id = aws_security_group.pipeline_lambda.id
}

# S3 gateway endpoint — keeps S3 traffic off NAT (free, same region)
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = data.terraform_remote_state.vpc.outputs.vpc_id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = data.terraform_remote_state.vpc.outputs.private_route_table_ids

  tags = merge(local.common_tags, { Name = "${local.prefix}-s3-endpoint" })
}
