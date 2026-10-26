# Midas (Star Capital) data mart access.
#
# Star Capital connects with an access key of the IAM user `midas.reader`
# (created by hand in each account; Terraform reads it and never manages it
# or its keys). With that key they generate an RDS IAM auth token for the
# Postgres user `midas_reader`, which can log in only with an IAM token and can
# read only the `midas` schema of views over the fund ledger (migration
# 20261026000003_midas_data_mart.sql).
#
# The only permission granted here is rds-db:connect for that one DB user.
# Runbook: docs/runbooks/midas-data-mart/README.md

data "aws_db_instance" "mna" {
  db_instance_identifier = "mna-${local.environment}-postgres"
}

data "aws_iam_user" "midas_reader" {
  user_name = var.iam_user_name
}

locals {
  db_connect_arn = (
    "arn:aws:rds-db:${var.aws_region}:${data.aws_caller_identity.current.account_id}:dbuser:${data.aws_db_instance.mna.resource_id}/${var.db_username}"
  )
}

resource "aws_iam_user_policy" "midas_rds_db_connect" {
  name = "rds-db-connect-${var.db_username}"
  user = data.aws_iam_user.midas_reader.user_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RdsIamDbConnectMidasReader"
        Effect   = "Allow"
        Action   = ["rds-db:connect"]
        Resource = local.db_connect_arn
      }
    ]
  })
}
