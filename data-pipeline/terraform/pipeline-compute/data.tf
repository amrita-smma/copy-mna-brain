# RDS instance — used to get DbiResourceId for rds-db:connect IAM policy ARNs
data "aws_db_instance" "mna" {
  db_instance_identifier = "mna-${local.environment}-postgres"
}

# Remote state: VPC
data "terraform_remote_state" "vpc" {
  backend = "s3"
  config = {
    bucket = local.tfstate_bucket
    key    = "env:/${terraform.workspace}/mna/vpc"
    region = var.aws_region
  }
}

# Remote state: RDS
data "terraform_remote_state" "rds" {
  backend = "s3"
  config = {
    bucket = local.tfstate_bucket
    key    = "env:/${terraform.workspace}/mna/rds"
    region = var.aws_region
  }
}

# RSS bronze bucket — created by terraform/s3-rss, consumed here for the
# Lambda env var and the S3 write policy.
data "terraform_remote_state" "s3_rss" {
  backend = "s3"

  config = {
    bucket = local.tfstate_bucket
    key    = "env:/${terraform.workspace}/mna/s3-rss"
    region = var.aws_region
  }
}
