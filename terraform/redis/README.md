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

terraform output -raw redis_url             # → REDIS_URL on Vercel (sensitive)
terraform output -raw redis_ca_pem_base64   # → REDIS_CA_PEM on Vercel (one line)
```

Set both on the Vercel project (Production and Preview; previews may share the
staging instance). Use the **base64** form of the CA for the dashboard: a
pasted multiline PEM does not always keep its newlines (Vercel previews lost
them and the handshake failed). The app accepts `REDIS_CA_PEM` as the PEM, as a
PEM with `\n` escapes, or as base64 (`readCaPem` in `src/lib/server/redis.ts`).

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

## Monitoring

### Alarms and dashboard

`monitoring.tf` adds:

- **A health probe on the box.** `redis-health-probe.timer` runs every
  minute and publishes to the CloudWatch namespace `MnA/Redis` (dimension
  `Environment`): `RedisUp` (INFO answered over TLS), `UsedMemoryPercentOfMax`,
  `ConnectedClients`, `ContainerRestarts`, `HostMemoryUsedPercent` and
  `DiskUsedPercent`. An SSM association (`AWS-RunShellScript`) installs it, not
  user_data, so changing the probe re-runs the association instead of
  replacing the instance. If the metrics stop arriving, look at the
  association in Systems Manager > State Manager.
- **Alarms** named `mna-<env>-redis-<check>`, which post ALARM and OK to the
  pipeline's alerts SNS topic (`mna-<env>-pipeline-alerts`). AWS Chatbot
  forwards that topic to `#mna-brain-alerts-<env>` in Slack, as it does for
  the pipeline Lambda alarms:

  | Alarm | Fires when |
  |---|---|
  | `down` | `RedisUp` is 0 or missing for 3 minutes (missing = the box is gone) |
  | `restarted` | Docker restarted a crashed container (the store is now empty) |
  | `memory-near-max` | memory ≥ `alarm_redis_memory_percent` (80%) of `maxmemory` for 5 minutes |
  | `host-memory-high` | host memory ≥ `alarm_host_memory_percent` (90%) for 5 minutes |
  | `disk-high` | root disk ≥ `alarm_disk_percent` (85%) |
  | `status-check-failed` | an EC2 status check fails for 2 minutes |
  | `cpu-high` | CPU ≥ `alarm_cpu_percent` (90%) for 15 minutes |

- **A dashboard**, `mna-<env>-redis`: `terraform output dashboard_url`.

The alerts topic belongs to `data-pipeline/terraform/pipeline-compute`, so
apply that module first in a new environment.

### Looking at Redis directly

The probe sends a few headline numbers. To see keys, clients or what is using
memory, ask Redis itself. The `Makefile` wraps the useful `redis-cli` calls:

```bash
make init-staging        # or init-production: picks which Redis you are looking at
make help                # list the targets
make redis-health        # start here
```

You need `redis-cli` locally (`brew install redis`) and AWS credentials that can
read the Terraform state. `redis-shell` and `redis-host` also need the
[Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html).
The targets read the host, password and CA from `terraform output`. The CA is
cached at `.terraform/redis-ca.pem`, which `make init-*` clears. Delete it by
hand after re-issuing the CA.

`make redis-health` prints a one-screen summary:

```
version      7.4.1 (up 3 days)
memory       1.21M of 256.00M (0.5%), peak 1.80M
keys (db0)   keys=42,expires=42,avg_ttl=31204,subexpiry=0
clients      6 connected, 0 blocked, 0 rejected since start
keys gone    18234 expired, 0 evicted since start
throughput   12 ops/s now, 9120334 commands since start
pub/sub      3 channels, 0 patterns
```

It adds a warning once memory passes 80% of `maxmemory`.

| Question | Target | What to look at |
|---|---|---|
| Space remaining | `redis-memory` | `used_memory_human` against `maxmemory_human`. With `noeviction`, a full store **rejects writes**; raise `redis_maxmemory` before that. |
| How many keys now | `redis-keys` | `keys=` and `expires=`. Every key the app writes has a TTL, so the two should match. A gap means something writes without an expiry. |
| Keys added / expired | `redis-stats`, `redis-commands` | Redis has no "keys ever added" counter. Use `calls=` on the write commands (`cmdstat_set`, …) plus `expired_keys`. `evicted_keys` should stay 0. |
| What is using memory | `redis-memkeys`, `redis-bigkeys` | Largest keys. Both use `SCAN`, so they are safe on the live server. |
| Who is connected | `redis-clients` | `connected_clients` and one line per connection. |
| Pub/sub fan-out | `redis-pubsub` | Each channel with its subscriber count (the SSE streams). |
| Slow commands | `redis-slowlog` | Commands slower than 10ms. |
| Live view | `redis-live` | Keys, memory, clients and requests every second. |
| Every command | `redis-monitor` | Streams all traffic. It slows the server, so run it briefly. |
| Ad hoc | `redis-cli` | An interactive session with the connection already set up. |
| The host | `redis-host`, `redis-shell` | Box memory and disk, `docker stats`, container health and recent unit logs over SSM. |

Every counter resets when the container restarts, including on an instance
replacement, which also empties the store. `uptime_in_days` tells you how far
back the numbers go.

The password goes to `redis-cli` through `REDISCLI_AUTH`, so it stays off the
command line and out of shell history. It is still in that process's
environment, which your own user can read (`ps eww`, `/proc/<pid>/environ`).
