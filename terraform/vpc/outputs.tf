output "vpc_id" {
  value = module.vpc.vpc_id
}

# List outputs (mining-legal compatible names for remote state)
output "public_subnet_id" {
  value = module.vpc.public_subnets
}

output "private_subnet_id" {
  value = module.vpc.private_subnets
}

output "vpc_cidr_block" {
  value = module.vpc.vpc_cidr_block
}

output "public_route_table_ids" {
  value = module.vpc.public_route_table_ids
}

output "private_route_table_ids" {
  value = module.vpc.private_route_table_ids
}

output "nat_gateway_ids" {
  value = module.vpc.natgw_ids
}

output "environment" {
  value = local.current_config.environment
}
