terraform {
  required_version = ">= 1.3"

  backend "s3" {
    key     = "mna/midas_reader"
    region  = "ap-southeast-3"
    encrypt = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.52"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
