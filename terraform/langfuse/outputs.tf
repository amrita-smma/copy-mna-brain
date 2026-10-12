output "public_ip" {
  description = "Elastic IP. Point the hostname's DNS A record here before the first apply finishes, or Caddy's certificate request will keep failing until you do."
  value       = aws_eip.langfuse.public_ip
}

output "hostname" {
  description = "Public hostname Caddy requests a certificate for"
  value       = local.hostname
}

output "base_url" {
  description = "Value for the app's LANGFUSE_BASE_URL"
  value       = "https://${local.hostname}"
}

output "dns_record" {
  description = "The DNS record to create. sqe.co.id is not in Route 53, so this is a manual step."
  value = {
    type  = "A"
    name  = local.hostname
    value = aws_eip.langfuse.public_ip
  }
}

output "instance_id" {
  description = "EC2 instance id — `aws ssm start-session --target <id>` for a shell"
  value       = aws_instance.langfuse.id
}

output "security_group_id" {
  value = aws_security_group.langfuse.id
}

output "data_volume_id" {
  description = "EBS volume holding Postgres, ClickHouse and the issued certificates"
  value       = aws_ebs_volume.data.id
}

output "blob_bucket" {
  description = "S3 bucket holding Langfuse ingestion events and media uploads"
  value       = aws_s3_bucket.blob.bucket
}

output "ssm_parameter_prefix" {
  description = "Where the generated credentials live"
  value       = local.ssm_prefix
}

# The project keys are what the app needs in LANGFUSE_PUBLIC_KEY /
# LANGFUSE_SECRET_KEY. Marked sensitive; read them with
# `terraform output -raw langfuse_secret_key` or from SSM.
output "langfuse_public_key" {
  description = "Value for the app's LANGFUSE_PUBLIC_KEY"
  value       = local.secret_parameters.PUBLIC_KEY.value
  sensitive   = true
}

output "langfuse_secret_key" {
  description = "Value for the app's LANGFUSE_SECRET_KEY"
  value       = local.secret_parameters.SECRET_KEY.value
  sensitive   = true
}

output "ui_login" {
  description = "Credentials for the seeded Langfuse UI account"
  value = {
    url      = "https://${local.hostname}"
    email    = var.init_user_email
    password = local.secret_parameters.INIT_USER_PASSWORD.value
  }
  sensitive = true
}

output "environment" {
  value = local.environment
}
