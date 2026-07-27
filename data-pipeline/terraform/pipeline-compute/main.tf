locals {
  # No-S3 email cutover — exactly two schedules. vault-archive-poll now does the
  # full single-pass process (privacy→LLM→CRM→AFD) inline from Lambda /tmp; no
  # MBOX bytes ever touch S3 and there is no separate email-process handoff.
  lambda_configs = {
    vault-archive-start = {
      handler      = "vaultArchiveStart.handler"
      schedule     = "cron(10 0 * * ? *)"
      description  = "Walk daily Vault windows; create matter+export, insert vault_exports rows"
      memory_heavy = false
      input        = jsonencode({})
    }
    vault-archive-poll = {
      handler              = "vaultArchivePoll.handler"
      schedule             = "cron(*/3 * * * ? *)"
      description          = "Poll vault_exports; on COMPLETED stream each MBOX via /tmp → privacy→LLM→CRM→AFD (no S3), resume on soft-stop"
      memory_heavy         = true
      ephemeral_storage_mb = 4096
      input                = jsonencode({})
    }
  }

  # Shared environment variables injected into every Lambda
  lambda_env = {
    # AWS_REGION is a Lambda reserved key — Lambda injects it automatically; omit here
    RDS_IAM_DB_AUTH = "true"
    DB_HOST         = data.terraform_remote_state.rds.outputs.db_endpoint
    DB_PORT         = tostring(data.terraform_remote_state.rds.outputs.db_port)
    DB_NAME         = "mna"
    DB_USER         = var.rds_db_username
    SSM_PREFIX      = "/mna/${local.environment}/pipeline"
    NODE_ENV        = local.environment
  }
}

module "pipeline_lambdas" {
  source = "./modules/pipeline-lambdas"

  lambda_configs           = local.lambda_configs
  prefix                   = local.prefix
  common_tags              = local.common_tags
  lambda_role_arn          = aws_iam_role.pipeline_lambda.arn
  lambda_security_group_id = aws_security_group.pipeline_lambda.id
  private_subnet_ids       = data.terraform_remote_state.vpc.outputs.private_subnet_id
  lambda_env               = local.lambda_env
  lambda_timeout_seconds   = var.lambda_timeout_seconds
  lambda_memory_mb         = var.lambda_memory_mb
  lambda_memory_mb_heavy   = var.lambda_memory_mb_heavy
  alerts_topic_arn         = aws_sns_topic.alerts.arn
}
