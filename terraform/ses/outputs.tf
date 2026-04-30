output "domain_identity_arn" {
  description = "ARN of the SES domain identity"
  value       = aws_ses_domain_identity.main.arn
}

output "domain_verification_token" {
  description = "Token to add as TXT record for domain verification"
  value       = aws_ses_domain_identity.main.verification_token
}

output "dkim_tokens" {
  description = "DKIM tokens to add as CNAME records for email authentication"
  value       = aws_ses_domain_dkim.main.dkim_tokens
}

output "mail_from_domain" {
  description = "Mail from domain for SPF records"
  value       = aws_ses_domain_mail_from.main.mail_from_domain
}

output "noreply_email" {
  description = "The noreply email address configured for this environment"
  value       = local.current_config.noreply_email
}

output "ses_send_email_policy_arn" {
  description = "Attach this policy to IAM users/roles that need to send emails via SES"
  value       = aws_iam_policy.ses_send_email.arn
}
