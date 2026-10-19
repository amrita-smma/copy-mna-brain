# App Redis (EC2)

The Redis the app uses for **live state only**: which bot is thinking right
now, Stop signals for running turns, and pub/sub fan-out to the browsers'
Server-Sent Events streams. Nothing durable lives here — bots, chat history,
LangGraph checkpoints and routines stay in Postgres. One `t3.small` runs a
single `redis:7` container under Docker Compose, TLS only.

## Shape

```
   Vercel functions (the app)            browsers
   REDIS_URL = rediss://…@<eip>:6379        │ SSE
   REDIS_CA_PEM pinned                      ▼
             │                        GET /api/bots/events  (Vercel)
             │  TLS + password              │ SUBSCRIBE
             ▼                              ▼
       ┌──────────────────────────────────────────┐
       │ EC2 t3.small (public subnet, Elastic IP) │
       │   redis:7  --port 0 --tls-port 6379      │
       │   /srv/redis/{docker-compose.yml,.env,tls/}
       └──────────────────────────────────────────┘
                      ▲ instance profile
            SSM /mna/<env>/redis/{REDIS_AUTH,TLS_*}
```

Deliberate choices:

- **Reachable from the internet.** The app runs on Vercel, outside the VPC,
  with no stable egress IPs on the Pro plan, so ElastiCache (VPC-only) is not
  an option and the security group cannot be narrowed to an IP list. The gate
  is TLS plus the generated 40-character password; the plaintext port is
  disabled in the container (`--port 0`), so there is nothing to connect to
  without both.
- **A private CA, issued by Terraform.** The only client pins the CA
  (`REDIS_CA_PEM`), so a public certificate buys nothing and an ACME flow on
  port 80 would be one more thing to keep alive. The CA and the server
  certificate (SAN: the Elastic IP) are `tls` provider resources in state and
  reach the box through SSM, so the CA survives an instance replacement and
  the PEM the app needs is a plain `terraform output`.
- **No persistence, no data volume.** `--save "" --appendonly no`. Every key
  the app writes expires within seconds to minutes; a replaced instance
  starting empty is correct, not data loss. `maxmemory 256mb` with
  `noeviction` makes a full store refuse writes rather than drop keys
  silently.
- **No SSH by default.** The instance profile carries
  `AmazonSSMManagedInstanceCore`, so `aws ssm start-session` is the shell.
- **Secrets via SSM, not user_data.** Terraform generates the password and
  certificates and writes them to `/mna/<env>/redis/*` as SecureStrings; the
  boot script reads them with the instance role. Anything in user_data is
  readable from the instance metadata endpoint by any process on the box.

## First apply

```bash
make init-staging          # or init-production
terraform apply

terraform output -raw redis_url      # → REDIS_URL on Vercel (sensitive)
terraform output -raw redis_ca_pem   # → REDIS_CA_PEM on Vercel (multiline, paste as-is)
```

Set both on the Vercel project (Production and Preview; previews may share the
staging instance). The app reads them in `src/lib/server/redis.ts`.

Check from outside AWS:

```bash
terraform output -raw redis_ca_pem > /tmp/redis-ca.pem
redis-cli --tls --cacert /tmp/redis-ca.pem \
  -h "$(terraform output -raw public_ip)" -p 6379 \
  -a "$(terraform output -raw redis_url | sed -E 's#rediss://default:([^@]+)@.*#\1#')" ping
# → PONG

redis-cli -h "$(terraform output -raw public_ip)" -p 6379 ping
# → connection error / protocol error: the plaintext port is off
```

## Operations

- **Shell:** `aws ssm start-session --target $(terraform output -raw instance_id)`.
  Logs: `journalctl -u redis`, `docker logs redis-redis-1`,
  `/var/log/redis-bootstrap.log`.
- **Rotate the password:** `terraform taint random_password.redis && terraform apply`,
  then on the box `systemctl restart redis` (it re-reads SSM on start), then
  update `REDIS_URL` on Vercel. Connections drop for a few seconds.
- **Re-issue certificates:** taint `tls_private_key.server` (server only; the
  pinned CA stays valid) or `tls_private_key.ca` (also update `REDIS_CA_PEM`),
  apply, restart the unit.
- **Replace the box:** any change to the templates replaces the instance
  (`user_data_replace_on_change`); the Elastic IP, password and certificates
  are separate resources and are kept.
- **Size:** `redis_maxmemory` is the only knob that should ever need raising;
  the instance class in `variables.tf` only if CPU is pinned.
