
variable "attach_rds_iam_db_connect_policy" {
  description = "Read RDS remote state and attach iam_db_connect_policy_arn to mna_devops and mna_maintainers. Set false if RDS state does not exist yet for this workspace."
  type        = bool
  default     = true
}

variable "additional_iam_role_names_for_rds_db_connect" {
  description = <<-EOT
    Optional IAM role names (e.g. AWSReservedSSO_* from IAM Identity Center) to attach the same
    rds-db:connect policy as the devops/maintainers groups. Use when engineers sign in via SSO
    assumed-role and are not in IAM groups mna_devops / mna_maintainers.
  EOT
  type        = list(string)
  default     = []
}

data "terraform_remote_state" "rds" {
  count = var.attach_rds_iam_db_connect_policy ? 1 : 0

  backend = "s3"
  config = {
    bucket = local.tfstate_bucket
    key    = "env:/${terraform.workspace}/mna/rds"
    region = var.aws_region
  }
}

locals {
  rds_remote_outputs = length(data.terraform_remote_state.rds) > 0 ? data.terraform_remote_state.rds[0].outputs : {}

  rds_iam_db_connect_policy_arn = try(local.rds_remote_outputs["iam_db_connect_policy_arn"], null)

  rds_db_endpoint_for_cli     = try(local.rds_remote_outputs["db_endpoint"], null)
  rds_db_port_for_cli         = try(local.rds_remote_outputs["db_port"], null)
  rds_iam_db_username_for_cli = try(local.rds_remote_outputs["iam_db_auth_username"], null)

  extra_iam_roles_for_rds_connect = (
    var.attach_rds_iam_db_connect_policy &&
    local.rds_iam_db_connect_policy_arn != null &&
    length(var.additional_iam_role_names_for_rds_db_connect) > 0
  ) ? toset(var.additional_iam_role_names_for_rds_db_connect) : toset([])
}

data "aws_iam_role" "rds_db_connect_extra" {
  for_each = local.extra_iam_roles_for_rds_connect
  name     = each.value
}

resource "aws_iam_role_policy_attachment" "extra_rds_db_connect" {
  for_each = local.extra_iam_roles_for_rds_connect

  role       = data.aws_iam_role.rds_db_connect_extra[each.key].name
  policy_arn = local.rds_iam_db_connect_policy_arn
}

resource "aws_iam_group_policy_attachment" "mna_devops_rds_iam_db_connect" {
  count = (
    var.attach_rds_iam_db_connect_policy &&
    local.environment != "dev" &&
    local.rds_iam_db_connect_policy_arn != null
  ) ? 1 : 0

  group      = aws_iam_group.mna_devops[0].name
  policy_arn = local.rds_iam_db_connect_policy_arn
}

resource "aws_iam_group_policy_attachment" "mna_maintainers_rds_iam_db_connect" {
  count = (
    var.attach_rds_iam_db_connect_policy &&
    local.environment != "dev" &&
    local.rds_iam_db_connect_policy_arn != null
  ) ? 1 : 0

  group      = aws_iam_group.mna_maintainers[0].name
  policy_arn = local.rds_iam_db_connect_policy_arn
}
