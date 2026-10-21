#!/bin/bash
set -euxo pipefail

NEO4J_VERSION="${neo4j_version}"
NEO4J_USERNAME="${neo4j_username}"
NEO4J_PASSWORD="${neo4j_password}"
NEO4J_HTTP_PORT="${neo4j_http_port}"
NEO4J_BOLT_PORT="${neo4j_bolt_port}"

LOG="/var/log/neo4j-setup.log"
exec > >(tee -a "$LOG") 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
  apt-transport-https \
  ca-certificates \
  curl \
  gnupg \
  jq \
  unzip \
  wget

# The stock Ubuntu AMI has no `aws` binary and the apt `awscli` package is the
# outdated v1. Install AWS CLI v2 from the official bundle so the backup/restore
# scripts can reach S3. Installs to /usr/local/bin/aws.
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) AWSCLI_URL="https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" ;;
  aarch64) AWSCLI_URL="https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" ;;
  *) echo "Unsupported architecture for AWS CLI: $ARCH" >&2; exit 1 ;;
esac
curl -fsSL "$AWSCLI_URL" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install
rm -rf /tmp/aws /tmp/awscliv2.zip
aws --version

# Neo4j requires a JRE; Temurin/OpenJDK 17 is supported by Neo4j 5.x.
apt-get install -y openjdk-17-jre-headless

# Add the official Neo4j apt repository (5.x channel).
wget -qO - https://debian.neo4j.com/neotechnology.gpg.key | gpg --dearmor -o /usr/share/keyrings/neo4j.gpg
echo "deb [signed-by=/usr/share/keyrings/neo4j.gpg] https://debian.neo4j.com stable 5" >/etc/apt/sources.list.d/neo4j.list
apt-get update -y

if [ -n "$NEO4J_VERSION" ]; then
  # Debian packages use an epoch prefix (1:) for the version.
  apt-get install -y "neo4j=1:$${NEO4J_VERSION}"
else
  apt-get install -y neo4j
fi

neo4j --version || true

CONF="/etc/neo4j/neo4j.conf"

# Listen on all interfaces so in-VPC clients can reach Bolt/HTTP via the private IP.
set_conf() {
  local key="$1"
  local value="$2"
  # Remove any existing (commented or active) entry, then append the desired one.
  sed -i "/^#\?$${key}=/d" "$CONF"
  echo "$${key}=$${value}" >>"$CONF"
}

set_conf "server.default_listen_address" "0.0.0.0"
set_conf "server.bolt.listen_address" ":$${NEO4J_BOLT_PORT}"
set_conf "server.http.listen_address" ":$${NEO4J_HTTP_PORT}"
set_conf "server.bolt.enabled" "true"
set_conf "server.http.enabled" "true"

mkdir -p /var/log/neo4j
chown -R neo4j:neo4j /var/log/neo4j

# Set the initial password for the built-in 'neo4j' superuser. This must happen
# before the database is first started. Disable shell tracing so the password
# is not written to the setup log.
set +x
sudo -u neo4j neo4j-admin dbms set-initial-password "$NEO4J_PASSWORD"
set -x

systemctl daemon-reload
systemctl enable neo4j
systemctl start neo4j

# Wait for Neo4j to accept HTTP connections.
READY=0
for i in {1..90}; do
  if systemctl is-active neo4j >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$NEO4J_HTTP_PORT/" >/dev/null 2>&1; then
    echo "Neo4j is ready on localhost:$NEO4J_HTTP_PORT"
    READY=1
    break
  fi
  sleep 2
done

if [ "$READY" -ne 1 ]; then
  echo "ERROR: Neo4j is not reachable on localhost:$NEO4J_HTTP_PORT"
  systemctl status neo4j --no-pager || true
  exit 1
fi

# If a custom admin username was requested, provision it in addition to the
# built-in 'neo4j' user. Native user creation requires Neo4j Enterprise; on
# Community this is a best-effort no-op and the 'neo4j' user remains the admin.
if [ -n "$NEO4J_USERNAME" ] && [ "$NEO4J_USERNAME" != "neo4j" ]; then
  set +x
  if command -v cypher-shell >/dev/null 2>&1; then
    cypher-shell -a "bolt://127.0.0.1:$NEO4J_BOLT_PORT" -u neo4j -p "$NEO4J_PASSWORD" \
      "CREATE USER $NEO4J_USERNAME IF NOT EXISTS SET PASSWORD '$NEO4J_PASSWORD' CHANGE NOT REQUIRED SET STATUS ACTIVE;" \
      || echo "WARN: could not create user '$NEO4J_USERNAME' (likely Community edition); using built-in 'neo4j' user."
    cypher-shell -a "bolt://127.0.0.1:$NEO4J_BOLT_PORT" -u neo4j -p "$NEO4J_PASSWORD" \
      "GRANT ROLE admin TO $NEO4J_USERNAME;" \
      || echo "WARN: could not grant admin role to '$NEO4J_USERNAME' (likely Community edition)."
  fi
  set -x
fi

# ---------------------------------------------------------------------------
# Backup / restore tooling
#
# Config lives in an env file so the scripts themselves stay static (and can be
# copy-pasted for manual runs). The scripts stop Neo4j for an offline dump —
# required on Community edition — then bring it back up.
# ---------------------------------------------------------------------------
BACKUP_BUCKET="${backup_bucket}"
AWS_REGION="${aws_region}"

cat >/etc/neo4j-backup.env <<EOF
BACKUP_BUCKET=$BACKUP_BUCKET
AWS_REGION=$AWS_REGION
DB_NAME=neo4j
EOF
chmod 0644 /etc/neo4j-backup.env

cat >/usr/local/bin/neo4j-backup.sh <<'BACKUP_EOF'
#!/bin/bash
# Dump the Neo4j database and upload it to S3.
# Neo4j Community must be offline for a dump, so we stop the service, dump,
# restart it, then upload. Downtime is limited to the dump itself.
set -euo pipefail

# shellcheck disable=SC1091
source /etc/neo4j-backup.env

TIMESTAMP="$(date +"%Y-%m-%d_%H-%M-%S")"
DUMP_DIR="$(mktemp -d)"

# Always remove the temp dir and make sure Neo4j is running again on exit,
# even if the dump or upload fails midway.
cleanup() {
  systemctl start neo4j >/dev/null 2>&1 || true
  rm -rf "$DUMP_DIR"
}
trap cleanup EXIT

echo "[neo4j-backup] Stopping neo4j for an offline dump"
systemctl stop neo4j

echo "[neo4j-backup] Dumping database '$DB_NAME'"
neo4j-admin database dump "$DB_NAME" --to-path="$DUMP_DIR" --overwrite-destination=true

echo "[neo4j-backup] Starting neo4j"
systemctl start neo4j

DEST="s3://$BACKUP_BUCKET/neo4j/$TIMESTAMP.dump"
echo "[neo4j-backup] Uploading to $DEST"
aws s3 cp "$DUMP_DIR/$DB_NAME.dump" "$DEST" --region "$AWS_REGION"

echo "[neo4j-backup] Done: $DEST"
BACKUP_EOF
chmod +x /usr/local/bin/neo4j-backup.sh

cat >/usr/local/bin/neo4j-restore.sh <<'RESTORE_EOF'
#!/bin/bash
# Restore a Neo4j dump from S3. Usage: neo4j-restore.sh [<s3-key>|latest]
# Defaults to the most recent dump. This OVERWRITES the current database.
set -euo pipefail

# shellcheck disable=SC1091
source /etc/neo4j-backup.env

KEY="$${1:-latest}"
DUMP_DIR="$(mktemp -d)"
trap 'rm -rf "$DUMP_DIR"' EXIT

if [ "$KEY" = "latest" ]; then
  LATEST="$(aws s3 ls "s3://$BACKUP_BUCKET/neo4j/" --region "$AWS_REGION" | sort | tail -n1 | awk '{print $4}')"
  if [ -z "$LATEST" ]; then
    echo "[neo4j-restore] No dumps found in s3://$BACKUP_BUCKET/neo4j/" >&2
    exit 1
  fi
  KEY="neo4j/$LATEST"
fi

echo "[neo4j-restore] Downloading s3://$BACKUP_BUCKET/$KEY"
aws s3 cp "s3://$BACKUP_BUCKET/$KEY" "$DUMP_DIR/$DB_NAME.dump" --region "$AWS_REGION"

echo "[neo4j-restore] Stopping neo4j"
systemctl stop neo4j

echo "[neo4j-restore] Loading dump into '$DB_NAME'"
neo4j-admin database load "$DB_NAME" --from-path="$DUMP_DIR" --overwrite-destination=true
chown -R neo4j:neo4j /var/lib/neo4j/data || true

echo "[neo4j-restore] Starting neo4j"
systemctl start neo4j

echo "[neo4j-restore] Restore complete from $KEY"
RESTORE_EOF
chmod +x /usr/local/bin/neo4j-restore.sh

# Schedule recurring backups via a systemd timer.
cat >/etc/systemd/system/neo4j-backup.service <<'EOF'
[Unit]
Description=Neo4j database backup to S3
After=neo4j.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/neo4j-backup.sh
EOF

cat >/etc/systemd/system/neo4j-backup.timer <<EOF
[Unit]
Description=Scheduled Neo4j database backup to S3

[Timer]
OnCalendar=${backup_schedule}
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now neo4j-backup.timer

echo "Neo4j setup complete."
