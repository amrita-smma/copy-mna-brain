# Bronze archive for the Data Navigator RSS lake.
#
# Deliberately separate from the app-data bucket and from the email pipeline
# (which has no S3 access at all, by design). Contents are machine-written
# NDJSON, replayable, and never served to browsers — hence no CORS and no
# versioning (the objects are already immutable, one per run).
resource "aws_s3_bucket" "rss_lake" {
  bucket = local.bucket_name

  tags = merge(local.common_tags, {
    Name = local.bucket_name
  })
}

resource "aws_s3_bucket_server_side_encryption_configuration" "rss_lake" {
  bucket = aws_s3_bucket.rss_lake.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "rss_lake" {
  bucket = aws_s3_bucket.rss_lake.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Bronze is the replay log — retained indefinitely per the approved design.
# Abort dangling multipart uploads so they can't accumulate storage cost.
resource "aws_s3_bucket_lifecycle_configuration" "rss_lake" {
  bucket = aws_s3_bucket.rss_lake.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
