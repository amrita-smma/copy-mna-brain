output "bucket_id" {
  description = "Name of the RSS lake bucket."
  value       = aws_s3_bucket.rss_lake.id
}

output "bucket_arn" {
  description = "ARN of the RSS lake bucket."
  value       = aws_s3_bucket.rss_lake.arn
}
