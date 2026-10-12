terraform {
  required_version = ">= 1.3"

  backend "s3" {
    key     = "mna/langfuse"
    region  = "ap-southeast-3"
    encrypt = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.79.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.5"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
