output "iam_user_arn" {
  description = "The IAM user Star Capital authenticates as (its access key is handed over via the password manager)"
  value       = data.aws_iam_user.midas_reader.arn
}

output "db_host" {
  value = data.aws_db_instance.mna.address
}

output "db_port" {
  value = data.aws_db_instance.mna.port
}

output "db_name" {
  value = data.aws_db_instance.mna.db_name
}

output "db_username" {
  description = "PostgreSQL user for the Midas data mart (token goes in the password field)"
  value       = var.db_username
}

output "db_connect_arn" {
  description = "The only rds-db:connect resource the IAM user is allowed"
  value       = local.db_connect_arn
}

output "generate_db_auth_token_cli" {
  description = "Run with midas.reader's credentials; the printed token is the password (valid 15 minutes, SSL required)"
  value       = "aws rds generate-db-auth-token --hostname ${data.aws_db_instance.mna.address} --port ${data.aws_db_instance.mna.port} --region ${var.aws_region} --username ${var.db_username}"
}

output "bootstrap_sql" {
  description = "Run once as the RDS master user if the migration could not create or grant midas_reader (it logs a NOTICE when it skips)"
  value       = <<-EOT
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${var.db_username}') THEN
        CREATE ROLE ${var.db_username} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 5;
      END IF;
    END $$;
    GRANT rds_iam TO ${var.db_username};
    GRANT CONNECT ON DATABASE ${data.aws_db_instance.mna.db_name} TO ${var.db_username};
    GRANT USAGE ON SCHEMA midas TO ${var.db_username};
    GRANT SELECT ON ALL TABLES IN SCHEMA midas TO ${var.db_username};
    ALTER ROLE ${var.db_username} SET search_path = midas;
    ALTER ROLE ${var.db_username} SET default_transaction_read_only = on;
    ALTER ROLE ${var.db_username} SET statement_timeout = '60s';
    ALTER ROLE ${var.db_username} SET idle_in_transaction_session_timeout = '60s';
  EOT
}
