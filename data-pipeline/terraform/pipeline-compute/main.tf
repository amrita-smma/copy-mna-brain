locals {
  # All Lambda functions: handler path in the bundle, cron schedule, memory override
  # handler = "src/lambda/<file>.handler" (esbuild bundles each to dist/<name>/index.js)
  lambda_configs = {
    crm-llm-submit = {
      handler      = "crmLlmSubmit.handler"
      schedule     = "cron(30 * * * ? *)"
      description  = "Submit raw_emails to Anthropic Batch API for LLM enrichment"
      memory_heavy = false
      input        = jsonencode({ limit = 300 })
    }
    crm-llm-fetch = {
      handler      = "crmLlmFetch.handler"
      schedule     = "cron(*/5 * * * ? *)"
      description  = "Poll Anthropic Batch API and write enrichment results"
      memory_heavy = false
      input        = jsonencode({})
    }
    crm-domain-classify = {
      handler      = "crmDomainClassify.handler"
      schedule     = "cron(45 * * * ? *)"
      description  = "Classify email sender domains via LLM"
      memory_heavy = false
      input        = jsonencode({ limit = 200 })
    }
    crm-ingest = {
      handler      = "crmIngest.handler"
      schedule     = "cron(50 * * * ? *)"
      description  = "Ingest enriched emails into CRM employers/correspondents/emails"
      memory_heavy = false
      input        = jsonencode({ limit = 2000 })
    }
    vault-parse = {
      handler      = "vaultParse.handler"
      schedule     = "cron(15 * * * ? *)"
      description  = "Parse mbox files from S3 into raw_emails (streaming)"
      memory_heavy = true
      input        = jsonencode({ limit = 10 })
    }
    vault-archive-start = {
      handler      = "vaultArchiveStart.handler"
      schedule     = "cron(5 * * * ? *)"
      description  = "Walk daily Vault windows; create matter+export, insert vault_exports rows"
      memory_heavy = false
      input        = jsonencode({})
    }
    vault-archive-poll = {
      handler      = "vaultArchivePoll.handler"
      schedule     = "cron(*/3 * * * ? *)"
      description  = "Poll vault_exports; on COMPLETED stream-download → S3 → mbox_files"
      memory_heavy = true
      input        = jsonencode({})
    }
  }

  # Shared environment variables injected into every Lambda
  lambda_env = {
    # AWS_REGION is a Lambda reserved key — Lambda injects it automatically; omit here
    RDS_IAM_DB_AUTH    = "true"
    DB_HOST            = data.terraform_remote_state.rds.outputs.db_endpoint
    DB_PORT            = tostring(data.terraform_remote_state.rds.outputs.db_port)
    DB_NAME            = "mna"
    DB_USER            = var.rds_db_username
    AWS_S3_MBOX_BUCKET = aws_s3_bucket.data_lake.id
    # Secrets are loaded at runtime via SSM — keys below tell the handler where to look
    SSM_PREFIX = "/mna/${local.environment}/pipeline"
    NODE_ENV   = local.environment
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
