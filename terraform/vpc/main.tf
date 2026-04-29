locals {
  vpc_configuration = coalesce(var.vpc, local.vpc_config)
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.19"

  name = local.vpc_configuration.name
  cidr = local.vpc_configuration.cidr_block

  azs             = var.availability_zones
  public_subnets  = local.vpc_configuration.public_subnets
  private_subnets = local.vpc_configuration.private_subnets

  enable_nat_gateway   = true
  single_nat_gateway   = true
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = local.all_tags

  vpc_tags = merge(local.all_tags, {
    Name = "${local.vpc_configuration.name}-vpc"
  })

  igw_tags = {
    Name = "${local.vpc_configuration.name}-igw"
  }

  nat_gateway_tags = {
    Name = "${local.vpc_configuration.name}-nat-gw"
  }

  public_subnet_tags = {
    Name = "${local.vpc_configuration.name}-public"
  }

  private_subnet_tags = {
    Name = "${local.vpc_configuration.name}-private"
  }
}
