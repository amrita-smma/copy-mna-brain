# Langfuse (self-hosted, EC2)

Self-hosted [Langfuse](https://langfuse.com) v3 for agent tracing. One EC2
instance runs the whole stack under Docker Compose: `langfuse-web`,
`langfuse-worker`, Postgres, ClickHouse, Redis, and Caddy terminating TLS.
Blob storage is a real S3 bucket (see below).

The app writes to it through `src/lib/langfuse.ts`. See
[`docs/features/langfuse-tracing.md`](../../docs/features/langfuse-tracing.md)
for what gets traced and how the app is wired.

## Shape

```
          internet
             │  :443
       ┌─────▼──────────────────────────────────┐
       │ EC2 (public subnet, Elastic IP)        │
       │                                        │
       │  caddy ──► langfuse-web ──┐            │
       │            langfuse-worker┤            │
       │                           ├─► postgres │
       │                           ├─► clickhouse
       │                           └─► redis    │
       │                                        │
       │  /srv/langfuse       (root EBS, config)│
       │  /srv/langfuse/data  (data EBS volume) │
       └───────────────┬────────────────────────┘
                       │ instance profile (no static keys)
                       ▼
            S3: mna-<env>-langfuse-<account>
                 events/  media/
```

Deliberate choices:

- **Databases on the box.** Langfuse's Postgres is *not* the app's RDS
  instance. Trace data is reconstructible telemetry, not business records, so
  it is not worth the extra moving parts — and keeping the stack close to the
  local `docker-compose.yml` means a trace looks the same in dev and in
  production.
- **Blob storage is S3, not MinIO.** The local stack uses MinIO for this and so
  did this module, until MinIO stopped publishing anonymously pullable images to
  Docker Hub — `minio/minio` now returns 401, which would wedge the instance's
  first boot. S3 is the better fit on EC2 regardless: the compose file sets no
  `LANGFUSE_S3_*_ACCESS_KEY_ID` at all, so Langfuse leaves credentials undefined
  and the AWS SDK resolves the instance profile. There is no static key pair in
  the system to leak or rotate. (Setting those vars to *empty strings* would
  break this — Langfuse only falls through when they are genuinely unset.)
- **Data on its own EBS volume.** Any edit to the bootstrap script replaces the
  instance (`user_data_replace_on_change`). The data volume is a separate
  resource with `prevent_destroy`, so history survives that. Caddy's issued
  certificates live there too, which keeps an instance replacement from
  re-requesting from Let's Encrypt and burning the duplicate-certificate rate
  limit.
- **Public subnet, Elastic IP.** Caddy answers the ACME HTTP-01 challenge on
  port 80, which needs an Internet Gateway route. Port 80 is therefore not
  optional — closing it breaks renewal, not just the redirect.
- **No SSH by default.** The instance profile carries
  `AmazonSSMManagedInstanceCore`, so `aws ssm start-session` is the shell.
  `ssh_ingress_cidrs` is empty unless you deliberately open it.
- **Secrets via SSM, not user_data.** Terraform generates every credential and
  writes it to `/mna/<env>/langfuse/*` as a SecureString. The boot script reads
  them with the instance role. Anything in user_data is readable from the
  instance metadata endpoint by any process on the box, so no secret goes there.

## First apply

DNS for `sqe.co.id` is not in Route 53, so the record is a manual step and the
order matters: Caddy will retry its certificate request until the name resolves,
but the instance serves nothing over HTTPS until it succeeds.

```bash
make init-staging          # or init-production
terraform apply

terraform output dns_record        # → { type = "A", name = ..., value = ... }
# Create that A record, then wait for propagation.

curl -sS https://$(terraform output -raw hostname)/api/public/health
# {"status":"OK",...}
```

**Without a DNS record.** Let's Encrypt issues certificates for a bare IP
address under its short-lived profile, which the Caddyfile requests, so the
Elastic IP can stand in for the hostname. Allocate it first so the instance is
built once, against its final address:

```bash
terraform apply -target=aws_eip.langfuse
IP=$(terraform state show -no-color aws_eip.langfuse | awk '$1 == "public_ip" {print $3}' | tr -d '"')
terraform apply -var "hostname=$IP"
```

Then write that IP into the workspace's `hostname` in `workspace_config`
(`variables.tf`), so later applies need no `-var` — without it they would
replace the instance back onto the default hostname. Staging is configured this
way. Moving to a DNS name later is a one-line change to that entry.

The Caddyfile sets `default_sni` to the hostname. Clients send no SNI for an IP
URL — Node's `fetch` included — and Caddy would otherwise abort those
handshakes for lack of a matching certificate.

Then put the credentials in the app's environment (Vercel, per environment):

```bash
terraform output -raw base_url              # LANGFUSE_BASE_URL
terraform output -raw langfuse_public_key   # LANGFUSE_PUBLIC_KEY
terraform output -raw langfuse_secret_key   # LANGFUSE_SECRET_KEY
```

UI sign-in for the seeded account:

```bash
terraform output -json ui_login
```

## Operating it

```bash
aws ssm start-session --target "$(terraform output -raw instance_id)"

sudo systemctl status langfuse
sudo docker compose -f /srv/langfuse/docker-compose.yml ps
sudo docker compose -f /srv/langfuse/docker-compose.yml logs -f langfuse-web
sudo cat /var/log/langfuse-bootstrap.log     # first-boot output
```

**Rotating a credential.** Change the value in SSM, then:

```bash
sudo /usr/local/bin/langfuse-refresh-env
sudo systemctl restart langfuse
```

Terraform keeps `ignore_changes = [value]` on every parameter, so it will not
write its originally generated value back over your rotation.

Note that rotating `ENCRYPTION_KEY` after first boot makes existing encrypted
rows unreadable, and rotating `SALT` invalidates every issued API key. Neither
is a routine operation.

**Changing the compose stack or the bootstrap.** Edit the files under
`templates/` and apply — the instance is replaced and comes back against the
same data volume and the same Elastic IP, so DNS does not change. Expect a few
minutes of downtime while images re-pull.

**Upgrading Langfuse.** Bump `langfuse_image_tag` (it defaults to the `3` major)
and apply. Schema migrations run automatically on worker start.

**Decommissioning.** The data volume carries `prevent_destroy`, so a plain
`terraform destroy` fails on it by design — that guard is what stops an
instance-replacement typo from deleting the trace history. To actually tear the
environment down, remove the `lifecycle` block from `aws_ebs_volume.data` and
apply that first, then destroy. Do not `state rm` the volume instead: it leaves
an unreferenced EBS volume billing quietly.

## Costs

Roughly, in `ap-southeast-3`, per month:

| | staging (`t3.small`, 50 GB) | production (`t3.large`, 200 GB) |
|---|---|---|
| Instance | ~$17 | ~$68 |
| Root + data EBS | ~$7 | ~$19 |
| S3 (blob) | <$1 | ~$2 |
| Elastic IP | ~$4 | ~$4 |

No ALB and no NAT traversal, which is the main reason this is cheaper than the
load-balanced alternative.

## Caveats

- **Single instance, no HA.** An instance failure loses trace *ingestion* until
  it comes back; the data volume survives. This is the right trade for
  telemetry, but do not put anything on this box that needs an SLA.
- **No automated backups.** Nothing snapshots the data volume on a schedule. If
  trace retention becomes something you actually depend on, add a DLM lifecycle
  policy — it is deliberately not here, because today the data is disposable.
- **Raw events expire after `event_retention_days` (30).** That lifecycle rule
  covers the `events/` prefix in S3 only, which is a replay buffer. The
  queryable traces live in ClickHouse on the data volume and are not expired by
  anything — they grow until the volume does.
- **`https_ingress_cidrs` defaults to the internet.** Vercel functions have no
  stable egress IPs without Secure Compute, so there is nothing narrower to
  allowlist. Langfuse's own auth is what protects the UI and the ingestion API.
