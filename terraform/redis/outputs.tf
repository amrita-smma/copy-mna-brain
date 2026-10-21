output "public_ip" {
  description = "Elastic IP the app connects to"
  value       = aws_eip.redis.public_ip
}

output "endpoint" {
  description = "host:port of the TLS Redis port"
  value       = "${aws_eip.redis.public_ip}:6379"
}

# Everything the app needs, in the shape its env wants it. Read with
# `terraform output -raw redis_url` / `terraform output -raw redis_ca_pem`.
output "redis_url" {
  description = "Value for the app's REDIS_URL (rediss://, password included)"
  value       = "rediss://default:${random_password.redis.result}@${aws_eip.redis.public_ip}:6379"
  sensitive   = true
}

output "redis_ca_pem" {
  description = "Value for the app's REDIS_CA_PEM: the private CA the server certificate chains to. Not secret, but multiline — paste as-is."
  value       = tls_self_signed_cert.ca.cert_pem
}

output "instance_id" {
  description = "EC2 instance id — `aws ssm start-session --target <id>` for a shell"
  value       = aws_instance.redis.id
}

output "security_group_id" {
  value = aws_security_group.redis.id
}

output "ssm_parameter_prefix" {
  description = "Where the generated credentials and certificates live"
  value       = local.ssm_prefix
}

output "environment" {
  value = local.environment
}

output "dashboard_url" {
  description = "CloudWatch dashboard for this Redis"
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards/dashboard/${aws_cloudwatch_dashboard.redis.dashboard_name}"
}
