# The Redis password and the TLS material. Generated here and written to SSM
# Parameter Store as SecureStrings; the instance reads them at boot with its
# instance profile, so no secret is ever rendered into user_data (which any
# process on the box can read from the metadata endpoint).
#
# TLS is a private CA of our own rather than Let's Encrypt: the only client is
# the app, which pins the CA (REDIS_CA_PEM), so a public chain buys nothing and
# an ACME flow on port 80 would be one more thing to keep working. Generating
# the certificates in Terraform (rather than on the box) means the CA survives
# an instance replacement without a data volume, and the PEM the app needs is
# a plain output.

resource "random_password" "redis" {
  length  = 40
  special = false
}

resource "tls_private_key" "ca" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_self_signed_cert" "ca" {
  private_key_pem = tls_private_key.ca.private_key_pem

  subject {
    common_name  = "${local.name_prefix}-ca"
    organization = "MnA"
  }

  is_ca_certificate     = true
  validity_period_hours = 87600 # 10 years
  early_renewal_hours   = 8760  # re-issue in the last year

  allowed_uses = [
    "cert_signing",
    "crl_signing",
    "digital_signature",
  ]
}

resource "tls_private_key" "server" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

# Clients connect by Elastic IP; the in-container healthcheck hits 127.0.0.1.
# Replacing the EIP re-issues this certificate (and the app's REDIS_URL changes
# anyway).
resource "tls_cert_request" "server" {
  private_key_pem = tls_private_key.server.private_key_pem

  subject {
    common_name  = local.name_prefix
    organization = "MnA"
  }

  ip_addresses = [aws_eip.redis.public_ip, "127.0.0.1"]
}

resource "tls_locally_signed_cert" "server" {
  cert_request_pem   = tls_cert_request.server.cert_request_pem
  ca_private_key_pem = tls_private_key.ca.private_key_pem
  ca_cert_pem        = tls_self_signed_cert.ca.cert_pem

  validity_period_hours = 43800 # 5 years
  early_renewal_hours   = 4380  # re-issue in the last six months

  allowed_uses = [
    "key_encipherment",
    "digital_signature",
    "server_auth",
  ]
}

locals {
  ssm_prefix = "/mna/${local.environment}/redis"

  # name => { value, description }. One map so the parameters, the IAM policy
  # and the boot-time fetch all derive from the same list and cannot drift
  # apart. The boot script writes the TLS_* values to files and everything else
  # to the compose .env.
  secret_parameters = {
    REDIS_AUTH = {
      value       = random_password.redis.result
      description = "requirepass for the app's Redis"
    }
    TLS_CA_CERT = {
      value       = tls_self_signed_cert.ca.cert_pem
      description = "Private CA certificate the app pins (REDIS_CA_PEM)"
    }
    TLS_SERVER_CERT = {
      value       = tls_locally_signed_cert.server.cert_pem
      description = "Redis server certificate (SAN: the Elastic IP)"
    }
    TLS_SERVER_KEY = {
      value       = tls_private_key.server.private_key_pem
      description = "Redis server private key"
    }
  }
}

resource "aws_ssm_parameter" "redis" {
  for_each = local.secret_parameters

  name        = "${local.ssm_prefix}/${each.key}"
  description = each.value.description
  type        = "SecureString"
  value       = each.value.value

  tags = local.environment_tags
}

# Non-secret pointer so the app's env wiring is discoverable without reading
# Terraform outputs.
resource "aws_ssm_parameter" "endpoint" {
  name        = "${local.ssm_prefix}/ENDPOINT"
  description = "Host:port of the app's Redis (TLS) — the host part of REDIS_URL"
  type        = "String"
  value       = "${aws_eip.redis.public_ip}:6379"

  tags = local.environment_tags
}
