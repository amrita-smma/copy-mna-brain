#!/bin/bash
# Exit 0 = skip build, exit 1 = proceed with build
commit_msg="$VERCEL_GIT_COMMIT_MESSAGE"

if [[ "$commit_msg" == *"[skip deploy]"* ]] || \
   [[ "$commit_msg" == *"[skip ci]"* ]] || \
   [[ "$commit_msg" == chore:* ]]; then
  echo "Skipping deploy: $commit_msg"
  exit 0
fi

exit 1
