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
