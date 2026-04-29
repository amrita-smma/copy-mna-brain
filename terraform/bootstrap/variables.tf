variable "aws_region" {
  description = "AWS region for tfstate bucket and lock table"
  type        = string
  default     = "ap-southeast-3"
}

variable "tags" {
  description = "Common tags for bootstrap resources"
  type        = map(string)
  default     = {}
}
