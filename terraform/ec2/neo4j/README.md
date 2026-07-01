# Terraform — Neo4j Server (EC2)

Provisions a single public Neo4j Community instance on EC2, plus an S3 bucket and
tooling for scheduled database backups.

## Usage

```bash
cd terraform/ec2/neo4j
make init-staging        # or: make init-production
terraform plan
terraform apply
```

Retrieve credentials after apply:

```bash
terraform output -raw neo4j_password
terraform output neo4j_credentials_summary
terraform output neo4j_backup_bucket
```

## Backups

Every instance provisions:

- **`/usr/local/bin/neo4j-backup.sh`** — stops Neo4j, runs `neo4j-admin database
  dump` (Community edition requires an offline dump), restarts Neo4j, and uploads
  the dump to `s3://<backup-bucket>/neo4j/<timestamp>.dump`. The service is
  always restarted on exit, even if the dump or upload fails.
- **`/usr/local/bin/neo4j-restore.sh [<s3-key>|latest]`** — downloads a dump
  (default: the most recent) and loads it, overwriting the current database.
- **`neo4j-backup.timer`** — a systemd timer that runs the backup on
  `var.backup_schedule` (default: daily at 02:00 instance time).

Backup destination: an S3 bucket named
`mna-neo4j-backups-<env>-<account_id>` with versioning, AES-256 encryption, all
public access blocked, and a lifecycle rule that expires dumps after
`var.backup_retention_days` (default 30) and superseded versions after 7 days.

The instance role (`neo4j_backups` policy) grants read/write only to this bucket.

### Running a backup or restore on demand

The instance has no SSH ingress; connect over SSM Session Manager (the role has
`AmazonSSMManagedInstanceCore`):

```bash
INSTANCE_ID=$(terraform output -raw neo4j_server_instance_id)
aws ssm start-session --target "$INSTANCE_ID" --region ap-southeast-3

# then, on the instance:
sudo /usr/local/bin/neo4j-backup.sh
sudo /usr/local/bin/neo4j-restore.sh latest
```

Check the timer / logs:

```bash
systemctl list-timers neo4j-backup.timer
journalctl -u neo4j-backup.service
```

## Preserving existing data across an apply

⚠️ This module sets `user_data_replace_on_change = true` and the root volume has
`delete_on_termination = true`. Any change to `user_data` (including adding this
backup tooling) **replaces the instance and destroys its data**. Follow this
order so the current database survives:

1. **Create the bucket and grant the running instance backup + SSM access first**
   (these are additive and do not replace the instance):

   ```bash
   terraform apply \
     -target=aws_s3_bucket.neo4j_backups \
     -target=aws_s3_bucket_versioning.neo4j_backups \
     -target=aws_s3_bucket_server_side_encryption_configuration.neo4j_backups \
     -target=aws_s3_bucket_public_access_block.neo4j_backups \
     -target=aws_s3_bucket_lifecycle_configuration.neo4j_backups \
     -target=aws_iam_role_policy.neo4j_backups \
     -target=aws_iam_role_policy_attachment.neo4j_ssm
   ```

2. **Back up the current database to the new bucket.** The old instance predates
   the backup script, so run the dump manually over SSM (allow a minute or two
   after step 1 for the SSM agent to register):

   ```bash
   INSTANCE_ID=$(terraform output -raw neo4j_server_instance_id)
   BUCKET=$(terraform output -raw neo4j_backup_bucket)
   aws ssm start-session --target "$INSTANCE_ID" --region ap-southeast-3

   # on the instance — the old instance has no aws binary, so install CLI v2 first:
   curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
   sudo apt-get install -y unzip && unzip -q /tmp/awscliv2.zip -d /tmp && sudo /tmp/aws/install

   TS=$(date +%Y-%m-%d_%H-%M-%S); D=$(mktemp -d)
   sudo systemctl stop neo4j
   sudo neo4j-admin database dump neo4j --to-path="$D" --overwrite-destination=true
   sudo systemctl start neo4j
   aws s3 cp "$D/neo4j.dump" "s3://<BUCKET-NAME>/neo4j/$TS.dump" --region ap-southeast-3
   ```

3. **Apply the rest.** This replaces the instance with one that has the backup
   tooling and timer baked in:

   ```bash
   terraform apply
   ```

4. **Restore onto the new instance** once it is up:

   ```bash
   INSTANCE_ID=$(terraform output -raw neo4j_server_instance_id)
   aws ssm start-session --target "$INSTANCE_ID" --region ap-southeast-3
   # on the instance:
   sudo /usr/local/bin/neo4j-restore.sh latest
   ```

From then on, backups run automatically on the timer and future instance
replacements can be recovered with `neo4j-restore.sh latest`.

## Key variables

| Variable | Default | Description |
|----------|---------|-------------|
| `backup_schedule` | `*-*-* 02:00:00` | systemd `OnCalendar` expression for the backup timer |
| `backup_retention_days` | `30` | Days to keep dumps before expiry |
| `instance_type` | `t3.medium` | EC2 instance type |
| `ebs_volume_size` | `50` | Root/data volume size (GB) |
| `allowed_cidr_blocks` | `[]` (→ `0.0.0.0/0`) | CIDRs allowed to reach Bolt/HTTP |

## Outputs

`neo4j_ip_address`, `neo4j_bolt_uri`, `neo4j_browser_url`, `neo4j_username`,
`neo4j_password` (sensitive), `neo4j_backup_bucket`, `neo4j_backup_bucket_arn`,
`neo4j_server_instance_id`.
