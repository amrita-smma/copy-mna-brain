#!/usr/bin/env bash

DOWN=true
BUILD=false
EXCLUDES=()

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
        *)
            echo "Unknown parameter passed: $1"
            show_help
            exit 1
            ;;
    esac
    shift
done

TARGET_SERVICES=()
if [ ${#EXCLUDES[@]} -gt 0 ]; then
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

if [ "$DOWN" = "true" ] || [ "$DOWN" = true ]; then
    echo "Stopping docker compose"
    docker compose -f docker-compose.yml down -v --remove-orphans "${TARGET_SERVICES[@]}"
    
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

echo "Refresh complete!"
