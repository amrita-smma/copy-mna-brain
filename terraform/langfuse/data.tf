# Remote state: VPC. The instance sits in the first public subnet so its Elastic
# IP has an Internet Gateway route — Caddy's HTTP-01 challenge needs the box to
# be reachable from Let's Encrypt, which a private subnet behind NAT is not.
data "terraform_remote_state" "vpc" {
  backend = "s3"
  config = {
    bucket = local.tfstate_bucket
    key    = "env:/${terraform.workspace}/mna/vpc"
    region = var.aws_region
  }
}

# Amazon Linux 2023, x86_64. Resolved through the public SSM alias rather than
# an aws_ami data source so the lookup is a single API call and cannot match a
# community image.
data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64"
}

data "aws_subnet" "selected" {
  id = local.subnet_id
}
