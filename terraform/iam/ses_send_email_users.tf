resource "aws_iam_user_policy_attachment" "ses_send_email" {
  for_each = toset(local.current_config.ses_send_email_users)

  user       = each.value
  policy_arn = data.terraform_remote_state.ses.outputs.ses_send_email_policy_arn
}
