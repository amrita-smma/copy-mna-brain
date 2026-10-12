# Langfuse's own secrets. Generated here and written to SSM Parameter Store as
# SecureStrings; the instance reads them at boot with its instance profile, so
# no secret is ever rendered into user_data (which any process on the box can
# read from the metadata endpoint).
#
# Every parameter carries ignore_changes on value: rotating a secret is done in
# SSM and the box picks it up on the next restart. Terraform must not fight that
# by writing its generated value back.

resource "random_password" "postgres" {
  length  = 32
  special = false
}

resource "random_password" "clickhouse" {
  length  = 32
  special = false
}

resource "random_password" "redis" {
  length  = 32
  special = false
}

resource "random_password" "nextauth_secret" {
  length  = 48
  special = false
}

resource "random_password" "salt" {
  length  = 32
  special = false
}

# Langfuse requires exactly 64 hex characters here (a 256-bit key); it refuses to
# boot otherwise. random_id gives raw bytes, hex-encoded, which is the only
# generator that satisfies that shape.
resource "random_id" "encryption_key" {
  byte_length = 32
}

# Alphanumeric only, like every other generated credential here. These values
# are written verbatim into a docker-compose `.env` file, which is line-oriented
# and unquoted — `$`, `#` and friends are parser-significant there. 24
# alphanumeric characters is ample entropy for a seeded UI login, and not having
# to escape anything removes a whole class of silent boot failure.
resource "random_password" "init_user_password" {
  length  = 24
  special = false
}

# Project API keys. These are what the app puts in LANGFUSE_PUBLIC_KEY /
# LANGFUSE_SECRET_KEY, so they must match the LANGFUSE_INIT_PROJECT_* values the
# containers seed on first boot.
resource "random_id" "project_public_key" {
  byte_length = 16
}

resource "random_id" "project_secret_key" {
  byte_length = 24
}

locals {
  ssm_prefix = "/mna/${local.environment}/langfuse"

  # name => { value, type, description }. One map so the parameters, the IAM
  # policy and the boot-time fetch all derive from the same list and cannot
  # drift apart.
  secret_parameters = {
    POSTGRES_PASSWORD = {
      value       = random_password.postgres.result
      description = "Password for the Langfuse Postgres container"
    }
    CLICKHOUSE_PASSWORD = {
      value       = random_password.clickhouse.result
      description = "Password for the Langfuse ClickHouse container"
    }
    REDIS_AUTH = {
      value       = random_password.redis.result
      description = "requirepass for the Langfuse Redis container"
    }
    NEXTAUTH_SECRET = {
      value       = random_password.nextauth_secret.result
      description = "NextAuth session signing secret for the Langfuse web UI"
    }
    SALT = {
      value       = random_password.salt.result
      description = "Langfuse API key hashing salt"
    }
    ENCRYPTION_KEY = {
      value       = random_id.encryption_key.hex
      description = "Langfuse at-rest encryption key (must stay 64 hex chars)"
    }
    INIT_USER_PASSWORD = {
      value       = random_password.init_user_password.result
      description = "Password for the Langfuse user seeded on first boot"
    }
    PUBLIC_KEY = {
      value       = "pk-lf-${random_id.project_public_key.hex}"
      description = "Langfuse project public key — set as LANGFUSE_PUBLIC_KEY in the app"
    }
    SECRET_KEY = {
      value       = "sk-lf-${random_id.project_secret_key.hex}"
      description = "Langfuse project secret key — set as LANGFUSE_SECRET_KEY in the app"
    }
  }
}

resource "aws_ssm_parameter" "langfuse" {
  for_each = local.secret_parameters

  name        = "${local.ssm_prefix}/${each.key}"
  description = each.value.description
  type        = "SecureString"
  value       = each.value.value

  tags = local.environment_tags

  lifecycle {
    ignore_changes = [value]
  }
}

# Non-secret pointer so the app's env wiring is discoverable without reading
# Terraform outputs.
resource "aws_ssm_parameter" "base_url" {
  name        = "${local.ssm_prefix}/BASE_URL"
  description = "Public Langfuse base URL — set as LANGFUSE_BASE_URL in the app"
  type        = "String"
  value       = "https://${local.hostname}"

  tags = local.environment_tags
}
