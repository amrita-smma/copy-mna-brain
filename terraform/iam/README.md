# Terraform - IAM for MnA Files S3 Access

This directory contains Terraform configuration for IAM resources to access the S3 bucket.

## Resources Created

| Resource | Name | Description |
|----------|------|-------------|
| IAM Policy | `mna-files-s3-policy` | Read/write access to S3 bucket |
| IAM Role | `mna-files-role` | Assumable by EC2/Lambda |
| IAM User | `mna-files-user` | For programmatic access |
| IAM Policy | `mna-app-bedrock-invoke` | `bedrock:InvokeModel` on the Titan embed model, for the app's search-query embeddings |
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

## Bedrock Permissions

`mna-app-bedrock-invoke` grants `bedrock:InvokeModel` on a single foundation
model ARN, built from `var.bedrock_region` and `var.bedrock_embedding_model`.

This is **not** for the pipeline Lambdas (they get their own policy in
`data-pipeline/terraform/pipeline-compute/iam.tf`). It is for the Next.js app:
`createContainer` builds a
`BedrockEmbeddingClient` (`src/lib/bedrock.ts`) to embed Data Navigator search
queries in-process, using this user's access keys.

⚠️ The failure mode is silent. `DataNavigatorService.vectorHalf` catches embed
errors, logs `[data-navigator] vector search unavailable:`, and returns `[]`,
so hybrid search degrades to trigram-only and still returns plausible results.
Three things must all be true or you get that degradation with no visible error:

1. This policy is attached, and its model ARN matches the app's
   `BEDROCK_REGION` / `BEDROCK_EMBEDDING_MODEL` env vars.
2. Model access for Titan Embed v2 is enabled in the Bedrock console for
   `var.bedrock_region` — IAM alone is not sufficient.
3. The `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` actually configured in
   Vercel belong to **this** user. `terraform/rds` can also mint a
   `mna-<env>-vercel-rds-iam` user whose variable description tells you to put
   its key in that same env-var pair, and that principal is scoped to
   `rds-db:connect` only — attaching Bedrock here would do nothing for it.
   Quick check without reading the secret: if S3 uploads work in that
   environment, the keys are `mna-app`, because `src/lib/s3.ts` signs with the
   same pair and would fail outright otherwise.

Verify against the **API**, not the page — `matchedBy` is produced by
`DataNavigatorService` but never rendered in the UI:

```bash
curl -s "https://<host>/api/data-navigator/search?q=series+B+funding" \
  -H "Cookie: <session>" | jq '.data[] | {title, matchedBy, score}'
```

All-`"text"` results are a *symptom*, not a diagnosis: an empty
`rss.item_chunks` (the enrich Lambda never ran) looks exactly the same. The
`[data-navigator] vector search unavailable:` line in the app logs is what
distinguishes a permissions failure from an empty index — present means the
embed call is failing, absent means there is simply nothing to match against.

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

