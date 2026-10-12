variable "aws_region" {
  type    = string
  default = "ap-southeast-3"
}

# Bedrock is used by the app itself, not just the pipeline Lambdas:
# `createContainer` builds a `BedrockEmbeddingClient` (src/lib/bedrock.ts) to
# embed Data Navigator search queries. These must stay in sync with the app's
# BEDROCK_REGION / BEDROCK_EMBEDDING_MODEL env vars and with
# data-pipeline/terraform/pipeline-compute/variables.tf — a mismatch produces a
# silent AccessDenied that degrades search to trigram-only.
variable "bedrock_region" {
  description = "Region used for the app's Bedrock calls. Bedrock is unavailable in ap-southeast-3, and Titan Embed v2 is not offered in ap-southeast-1."
  type        = string
  default     = "ap-southeast-2"
}

variable "bedrock_embedding_model" {
  description = "Bedrock embedding model id the app invokes to embed search queries. Must match the pipeline's model so query and chunk vectors are comparable."
  type        = string
  default     = "amazon.titan-embed-text-v2:0"
}

variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_caller_identity" "current" {}

locals {
  tfstate_bucket = "mna-tfstate-${terraform.workspace}-${data.aws_caller_identity.current.account_id}"

  workspace_config = {
    dev = {
      environment          = "dev"
      mna_devops_users     = ["nico.alimin"]
      mna_developer_users  = []
      ses_send_email_users = []
      tags = {
        Environment = "dev"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
    staging = {
      environment = "staging"
      mna_devops_users = [
        "nico.alimin",
        "kensen.huang",
      ]
      mna_developer_users = []
      ses_send_email_users = [
        "kensen.huang",
        "nico.alimin",
      ]
      tags = {
        Environment = "staging"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
    production = {
      environment = "production"
      # kensen.huang moved out of mna_devops (AdministratorAccess) and into
      # mna_developer, which stops short of AdministratorAccess (no bulk IAM
      # user/policy management). Leaving them in both groups would make the
      # narrower group meaningless.
      mna_devops_users = [
        "nico.alimin",
        "asep.taufik",
        "kensen.huang",
      ]
      mna_developer_users = [
        "kensen.huang",
      ]
      ses_send_email_users = [
        "nico.alimin",
      ]
      tags = {
        Environment = "production"
        Project     = "MnA"
        ManagedBy   = "Terraform"
      }
    }
  }

  current_config = lookup(local.workspace_config, terraform.workspace, local.workspace_config["dev"])
  environment    = local.current_config.environment
  common_tags    = merge(local.current_config.tags, var.tags)
}
