terraform {
  required_version = ">= 1.3"

  backend "s3" {
    key    = "mna/s3-rss"
    region = "ap-southeast-3"
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.3.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
