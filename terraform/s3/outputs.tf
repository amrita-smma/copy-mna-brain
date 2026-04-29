output "bucket_id" {
  value = aws_s3_bucket.app_data.id
}

output "bucket_arn" {
  value = aws_s3_bucket.app_data.arn
}

output "app_data_rw_policy_arn" {
  description = "Attach this policy to IAM users/roles (e.g. CI, operators) that need S3 app-data access"
  value       = aws_iam_policy.app_data_rw.arn
}
