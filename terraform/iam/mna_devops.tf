resource "aws_iam_group" "mna_devops" {
  name = "mna_devops"
}

resource "aws_iam_group_membership" "mna_devops" {
  name  = "mna_devops_membership"
  group = aws_iam_group.mna_devops.name
  users = local.current_config.mna_devops_users
}

resource "aws_iam_group_policy_attachment" "mna_devops_admin" {
  group      = aws_iam_group.mna_devops.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

# These resources used to carry `count`; the moved blocks keep their state addresses.
moved {
  from = aws_iam_group.mna_devops[0]
  to   = aws_iam_group.mna_devops
}

moved {
  from = aws_iam_group_membership.mna_devops[0]
  to   = aws_iam_group_membership.mna_devops
}

moved {
  from = aws_iam_group_policy_attachment.mna_devops_admin[0]
  to   = aws_iam_group_policy_attachment.mna_devops_admin
}
