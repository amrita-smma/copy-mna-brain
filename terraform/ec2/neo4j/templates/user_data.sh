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
  wget

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

echo "Neo4j setup complete."
