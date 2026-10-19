# Remote state: VPC. The instance sits in the first public subnet with an
# Elastic IP because its only client is the app on Vercel, which runs outside
# the VPC and has no stable egress IPs — the box must be reachable from the
# internet (TLS + password are the gate, see main.tf).
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
