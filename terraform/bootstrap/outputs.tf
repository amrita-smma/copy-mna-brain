output "tfstate_bucket_name" {
  description = "S3 bucket for Terraform remote state"
  value       = aws_s3_bucket.tfstate.bucket
}

output "aws_account_id" {
  value = data.aws_caller_identity.current.account_id
}

output "environment" {
  value = local.environment
}
