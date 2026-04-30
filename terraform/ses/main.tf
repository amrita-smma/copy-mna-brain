# SES Domain Identity
resource "aws_ses_domain_identity" "main" {
  domain = local.current_config.domain
}

# SES Domain DKIM
resource "aws_ses_domain_dkim" "main" {
  domain = aws_ses_domain_identity.main.domain
}

# SES Email Identity for noreply address
resource "aws_ses_email_identity" "noreply" {
  email = local.current_config.noreply_email
}

# SES Domain Mail From (optional but recommended for better deliverability)
resource "aws_ses_domain_mail_from" "main" {
  domain           = aws_ses_domain_identity.main.domain
  mail_from_domain = "mail.${aws_ses_domain_identity.main.domain}"
}

# IAM Policy for sending emails via SES
resource "aws_iam_policy" "ses_send_email" {
  name        = "mna-${local.current_config.environment}-ses-send-email"
  description = "MnA SES send email policy (attach to IAM users/roles that need to send emails)"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SendEmail"
        Effect = "Allow"
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "ses:FromAddress" = local.current_config.noreply_email
          }
        }
      },
      {
        Sid    = "GetSendQuota"
        Effect = "Allow"
        Action = [
          "ses:GetSendQuota",
          "ses:GetSendStatistics"
        ]
        Resource = "*"
      }
    ]
  })

  tags = local.environment_tags
}
