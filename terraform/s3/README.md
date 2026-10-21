# Terraform - S3 Bucket for MnA Files

This directory contains Terraform configuration for AWS S3 infrastructure.

## Prerequisites

1. **AWS CLI** installed and configured
2. **Terraform** v1.0+ installed
3. AWS credentials with S3 permissions

## Configure AWS Credentials

```bash
# Option 1: AWS CLI configuration
aws configure

# Option 2: Environment variables
export AWS_ACCESS_KEY_ID="your-access-key"
export AWS_SECRET_ACCESS_KEY="your-secret-key"
export AWS_REGION="ap-southeast-3"
```

## Usage

### Initialize Terraform

First time setup - downloads required providers:

```bash
cd terraform/s3
terraform init
```

### Preview Changes (Plan)

See what Terraform will create/modify/destroy:

```bash
terraform plan
```

### Apply Changes

Create or update infrastructure:

```bash
terraform apply
```

Review the plan and type `yes` to confirm.

### Destroy Infrastructure

To tear down all resources:

```bash
terraform destroy
```

## State Management

⚠️ **Important**: The `terraform.tfstate` file is checked into Git for this project.

- Always pull latest changes before running `terraform plan` or `apply`
- Commit state file changes immediately after `terraform apply`
- Coordinate with team members to avoid concurrent modifications

```bash
# Before making changes
git pull origin main

# After applying changes
git add terraform/s3/terraform.tfstate
git commit -m "Update terraform state"
git push
```

## Resources Created

| Resource | Name | Description |
|----------|------|-------------|
| S3 Bucket | `mna-files-notes` | Storage for files notes |

### Bucket Configuration

- **Region**: ap-southeast-3 (Jakarta)
- **Versioning**: Enabled
- **Encryption**: AES-256 server-side encryption
- **Public Access**: Blocked

## Tags

All resources are tagged with:

```hcl
Environment = "staging" # or "production"
Project     = "MnA"
ManagedBy   = "Terraform"
```
