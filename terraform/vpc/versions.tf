terraform {
  required_version = ">= 1.3"

  backend "s3" {
    key     = "mna/vpc"
    region  = "ap-southeast-3"
    encrypt = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.79.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
