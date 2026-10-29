#!/usr/bin/env bash
set -euo pipefail

# Start or stop an optional docker-compose stack used after docker-refresh:lite.
#
# Usage:
#   bash scripts/docker-run.sh <mailhog|s3|langfuse|redis> [down]
#   pnpm docker:run-mailhog
#   pnpm docker:run-mailhog -- down

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

STACK="${1:-}"
ACTION="${2:-up}"

if [ -z "$STACK" ]; then
  echo "Usage: $0 <mailhog|s3|langfuse|redis> [down]"
  exit 1
fi

if [ "$ACTION" != "up" ] && [ "$ACTION" != "down" ]; then
  echo "Unknown argument: $ACTION (expected 'down' or omit for up)"
  exit 1
fi

# Services started for `up` may include shared deps; `down` only stops the
# stack's own containers so e.g. `langfuse down` does not tear down S3.
case "$STACK" in
  mailhog)
    UP_SERVICES=(mailhog)
    DOWN_SERVICES=(mailhog)
    ;;
  s3)
    # S3-compatible storage (SeaweedFS); creates its buckets on startup.
    UP_SERVICES=(s3)
    DOWN_SERVICES=(s3)
    ;;
  redis)
    # The app's own Redis (bot presence, Stop signals, live updates).
    # REDIS_URL=redis://localhost:6379
    UP_SERVICES=(redis)
    DOWN_SERVICES=(redis)
    ;;
  langfuse)
    # The `langfuse` S3 bucket must exist before Langfuse workers start.
    UP_SERVICES=(s3 langfuse-redis langfuse-clickhouse langfuse-worker langfuse-web)
    DOWN_SERVICES=(langfuse-redis langfuse-clickhouse langfuse-worker langfuse-web)
    ;;
  *)
    echo "Unknown stack: $STACK (expected mailhog|s3|langfuse|redis)"
    exit 1
    ;;
esac

if [ "$ACTION" = "down" ]; then
  echo "Stopping ${STACK} (${DOWN_SERVICES[*]})..."
  docker compose -f docker-compose.yml stop "${DOWN_SERVICES[@]}"
  docker compose -f docker-compose.yml rm -f "${DOWN_SERVICES[@]}"
  echo "${STACK} stopped."
  exit 0
fi

echo "Starting ${STACK} (${UP_SERVICES[*]})..."
docker compose -f docker-compose.yml up -d "${UP_SERVICES[@]}"

if [ "$STACK" = "langfuse" ]; then
  LANGFUSE_URL="${LANGFUSE_BASE_URL:-http://localhost:3030}"
  HEALTH_URL="${LANGFUSE_URL%/}/api/public/health"
  echo "Waiting for Langfuse health at ${HEALTH_URL}..."
  attempts=0
  until curl -sf -o /dev/null "$HEALTH_URL"; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 90 ]; then
      echo "Error: Langfuse did not become ready within 90s."
      exit 1
    fi
    if (( attempts % 5 == 0 )); then
      echo "  still waiting... (${attempts}s)"
    fi
    sleep 1
  done

  echo "Running Langfuse model pricing seed..."
  pnpm db:seed:langfuse
  echo "Langfuse ready at ${LANGFUSE_URL}"
fi
