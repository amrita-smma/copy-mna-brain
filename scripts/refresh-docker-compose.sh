#!/usr/bin/env bash

DOWN=true
BUILD=false
EXCLUDES=()
ONLY=()

function show_help {
    echo "=================================="
    echo "refresh-docker-compose.sh Utility"
    echo "=================================="

    echo ""
    echo "Purpose: Automatically refreshes docker compose services by dropping existing volumes."
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -h, --help               Show this help message and exit"
    echo "  --down <true|false>      Whether to bring down docker compose before starting (default: true)"
    echo "  --build <true|false>     Whether to build images before starting (default: false)"
    echo "  --exclude <services>     List of services to exclude, separated by comma or space."
    echo "                           Can be specified multiple times."
    echo "  --only <services>        List of services to explicitly target, separated by comma or space."
    echo "                           Overrides --exclude if both are provided."
    echo ""
    echo "Examples:"
    echo "  $0 --exclude \"neo4j,postgres\""
    echo "  $0 --down false --build true --exclude app"
}

while [[ "$#" -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        --down) DOWN="$2"; shift ;;
        --build) BUILD="$2"; shift ;;
        --exclude)
            IFS=', ' read -r -a arr <<< "$2"
            EXCLUDES+=("${arr[@]}")
            shift
            ;;
        --only)
            IFS=', ' read -r -a arr <<< "$2"
            ONLY+=("${arr[@]}")
            shift
            ;;
        *)
            echo "Unknown parameter passed: $1"
            show_help
            exit 1
            ;;
    esac
    shift
done

TARGET_SERVICES=()
if [ ${#ONLY[@]} -gt 0 ]; then
    TARGET_SERVICES=("${ONLY[@]}")
elif [ ${#EXCLUDES[@]} -gt 0 ]; then
    ALL_SERVICES=$(docker compose -f docker-compose.yml config --services)
    for svc in $ALL_SERVICES; do
        EXCLUDED=false
        for ex in "${EXCLUDES[@]}"; do
            if [ "$svc" == "$ex" ]; then
                EXCLUDED=true
                break
            fi
        done
        if [ "$EXCLUDED" == false ]; then
            TARGET_SERVICES+=("$svc")
        fi
    done
fi

# Full stack (no --only / --exclude) starts every service, including Langfuse.
# Otherwise seed only when a langfuse-* service is in the target set.
needs_langfuse_seed=false
if [ ${#ONLY[@]} -eq 0 ] && [ ${#EXCLUDES[@]} -eq 0 ]; then
    needs_langfuse_seed=true
else
    for svc in "${TARGET_SERVICES[@]}"; do
        case "$svc" in
            langfuse-*)
                needs_langfuse_seed=true
                break
                ;;
        esac
    done
fi

if [ "$DOWN" = "true" ] || [ "$DOWN" = true ]; then
    echo "Stopping docker compose"
    docker compose -f docker-compose.yml down -v --remove-orphans
    
    echo "Rotating AUTH_SECRET to invalidate old sessions..."
    # Generate a new 32-byte hex secret
    NEW_SECRET=$(openssl rand -hex 32)
    # Replace the existing AUTH_SECRET in .env.local (works on both Linux and macOS)
    sed -i "s/^AUTH_SECRET=.*/AUTH_SECRET=$NEW_SECRET/" .env.local
fi

if [ "$BUILD" = "true" ] || [ "$BUILD" = true ]; then
    echo "Rebuilding docker compose with build"
    docker compose -f docker-compose.yml up -d --build "${TARGET_SERVICES[@]}"
else
    echo "Rebuilding docker compose"
    docker compose -f docker-compose.yml up -d "${TARGET_SERVICES[@]}"
fi

echo "Checking database connection..."
PING_OUTPUT=$(pnpm db:ping 2>&1)
PING_EXIT_CODE=$?
echo "$PING_OUTPUT"

if [ $PING_EXIT_CODE -ne 0 ]; then
    echo "Error: Database connection failed."
    exit 1
fi

if ! echo "$PING_OUTPUT" | grep -qE 'host:[[:space:]]+(localhost|127\.0\.0\.1|0\.0\.0\.0)'; then
    echo "Error: Target database is not local."
    exit 1
fi

echo "Running database migrations..."
if ! pnpm db:migrate; then
    echo "Error: Database migration failed."
    exit 1
fi

echo "Running database seed..."
if ! pnpm db:seed; then
    echo "Error: Database seed failed."
    exit 1
fi

if [ "$needs_langfuse_seed" = true ]; then
    echo "Running Langfuse model pricing seed..."
    if ! pnpm db:seed:langfuse; then
        echo "Error: Langfuse seed failed."
        exit 1
    fi
else
    echo "Skipping Langfuse seed (Langfuse services not in target set)."
    echo "Start later with: pnpm docker:run-langfuse"
fi

# Remind when MinIO was not part of the target set (lite refresh).
needs_minio_hint=false
if [ ${#ONLY[@]} -gt 0 ] || [ ${#EXCLUDES[@]} -gt 0 ]; then
    needs_minio_hint=true
    for svc in "${TARGET_SERVICES[@]}"; do
        if [ "$svc" = "minio" ] || [ "$svc" = "minio-init" ]; then
            needs_minio_hint=false
            break
        fi
    done
fi
if [ "$needs_minio_hint" = true ]; then
    echo "MinIO not in target set — S3 uploads need: pnpm docker:run-minio"
fi

echo "Refresh complete!"
