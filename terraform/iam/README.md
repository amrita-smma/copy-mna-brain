# Terraform - IAM for MnA Files S3 Access

This directory contains Terraform configuration for IAM resources to access the S3 bucket.

## Resources Created

| Resource | Name | Description |
|----------|------|-------------|
| IAM Policy | `mna-files-s3-policy` | Read/write access to S3 bucket |
| IAM Role | `mna-files-role` | Assumable by EC2/Lambda |
| IAM User | `mna-files-user` | For programmatic access |
| Access Key | - | Credentials for the IAM user |

## Prerequisites

1. **S3 bucket must exist first** - Run `terraform apply` in the `../s3` directory first
2. AWS credentials with IAM permissions

## Usage

### Initialize

```bash
cd terraform/iam
terraform init
```

### Plan & Apply

```bash
terraform plan
terraform apply
```

### Get Access Credentials

After applying, retrieve the access key and secret:

```bash
# View access key ID
terraform output access_key_id

# View secret access key (sensitive)
terraform output -raw secret_access_key
```

⚠️ **Important**: Store these credentials securely. The secret key is only available immediately after creation.

## IAM Policy Permissions

The policy grants the following S3 permissions:

**Bucket Level:**
- `s3:ListBucket`
- `s3:GetBucketLocation`

**Object Level:**
- `s3:GetObject`
- `s3:PutObject`
- `s3:DeleteObject`
- `s3:GetObjectVersion`
- `s3:GetObjectAcl`
- `s3:PutObjectAcl`

## Using the IAM Role

The role can be assumed by:
- EC2 instances
- Lambda functions

To use with other services, modify the `assume_role_policy` in `main.tf`.

## Using the IAM User

Configure AWS CLI with the user credentials:

```bash
aws configure --profile mna-files
# Enter the access key ID and secret access key
```

Then use the profile:

```bash
aws s3 ls s3://mna-files --profile mna-files
```

