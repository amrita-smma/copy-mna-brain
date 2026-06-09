#!/bin/bash
# Usage: pnpm sam <FunctionName>
# Generates the EventBridge event file then invokes the given SAM function.
set -e
sam local generate-event cloudwatch scheduled-event > /tmp/event.json
exec sam local invoke \
  --template template.local.yaml \
  --event /tmp/event.json \
  --add-host host.docker.internal:host-gateway \
  "$@"
