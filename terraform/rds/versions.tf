terraform {
  required_version = ">= 1.3"

  backend "s3" {
    key     = "mna/rds"
    region  = "ap-southeast-3"
    encrypt = true
  }

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Pin to the 6.x line at >= 6.52.0. The state was written by a provider
      # newer than 6.31.0 whose aws_iam_user resource-identity schema includes
      # `account_id`; 6.31.0 cannot decode that identity ("unsupported attribute
      # account_id"). Staying on a recent 6.x keeps the identity schema
      # compatible. Do not float to 7.x, which may change the identity schema
      # again and reintroduce the decode error.
      version = "~> 6.52"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
