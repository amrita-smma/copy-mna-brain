# Require TLS for all PostgreSQL connections (client must use sslmode=require or stricter).
resource "aws_db_parameter_group" "mna_postgres" {
  name        = "mna-${local.current_config.environment}-pg16-forcessl"
  family      = "postgres16"
  description = "MnA Postgres 16 with rds.force_ssl"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "immediate"
  }

  tags = merge(local.environment_tags, {
    Name = "mna-${local.current_config.environment}-pg16-forcessl"
  })

  lifecycle {
    create_before_destroy = true
  }
}
