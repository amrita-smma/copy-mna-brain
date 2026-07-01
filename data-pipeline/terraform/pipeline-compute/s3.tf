resource "aws_s3_bucket" "data_lake" {
  bucket = "mna-data-lake-${local.environment}"

  tags = merge(local.common_tags, { Name = "mna-data-lake-${local.environment}" })
}

resource "aws_s3_bucket_versioning" "data_lake" {
  bucket = aws_s3_bucket.data_lake.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data_lake" {
  bucket = aws_s3_bucket.data_lake.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "data_lake" {
  bucket = aws_s3_bucket.data_lake.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "data_lake_attachment_archive" {
  count = var.attachment_archive_lifecycle.enabled ? 1 : 0

  bucket = aws_s3_bucket.data_lake.id

  rule {
    id     = "attachment-pipeline-archive-retention"
    status = "Enabled"

    filter {
      prefix = var.attachment_archive_lifecycle.prefix
    }

    transition {
      days          = var.attachment_archive_lifecycle.glacier_transition_days
      storage_class = "GLACIER"
    }

    noncurrent_version_transition {
      noncurrent_days = var.attachment_archive_lifecycle.glacier_transition_days
      storage_class   = "GLACIER"
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = var.attachment_archive_lifecycle.incomplete_multipart_upload_expiration_days
    }
  }
}

resource "aws_iam_policy" "data_lake_rw" {
  name        = "${local.prefix}-data-lake-rw"
  description = "Pipeline Lambda read/write to data-lake S3 bucket"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ListBucket"
        Effect = "Allow"
        Action = [
          "s3:ListBucket",
          "s3:GetBucketLocation"
        ]
        Resource = aws_s3_bucket.data_lake.arn
      },
      {
        Sid    = "ObjectRW"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:GetObjectVersion"
        ]
        Resource = "${aws_s3_bucket.data_lake.arn}/*"
      }
    ]
  })

  tags = local.common_tags
}
