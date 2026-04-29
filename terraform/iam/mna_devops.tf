resource "aws_iam_group" "mna_devops" {
  count = local.environment == "dev" ? 0 : 1
  name  = "mna_devops"
}

resource "aws_iam_group_membership" "mna_devops" {
  count = local.environment == "dev" ? 0 : 1
  name  = "mna_devops_membership"
  group = aws_iam_group.mna_devops[0].name
  users = local.current_config.mna_devops_users
}

resource "aws_iam_group_policy_attachment" "mna_devops_admin" {
  count      = local.environment == "dev" ? 0 : 1
  group      = aws_iam_group.mna_devops[0].name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
