# Blob storage for Langfuse ingestion events and media.
#
# The local docker-compose stack uses SeaweedFS for this (it replaced MinIO,
# whose `minio/minio` image now 401s for anonymous pulls). S3 is the better
# answer on EC2: the instance profile authenticates it,
# so there is no static key pair to store or rotate, and the bucket is durable
# independently of the box.

resource "aws_s3_bucket" "blob" {
  bucket = "${local.name_prefix}-${data.aws_caller_identity.current.account_id}"

  tags = merge(local.environment_tags, {
    Name = "${local.name_prefix}-blob"
  })
}

resource "aws_s3_bucket_public_access_block" "blob" {
  bucket = aws_s3_bucket.blob.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "blob" {
  bucket = aws_s3_bucket.blob.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Raw ingestion events are a replay/debug buffer, not the trace store — the
# queryable copy lives in ClickHouse. Letting them accumulate forever is pure
# cost, so they expire on the same schedule as the traces they belong to.
resource "aws_s3_bucket_lifecycle_configuration" "blob" {
  bucket = aws_s3_bucket.blob.id

  rule {
    id     = "expire-events"
    status = "Enabled"

    filter {
      prefix = "events/"
    }

    expiration {
      days = var.event_retention_days
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
