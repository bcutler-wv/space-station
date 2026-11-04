#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 3 && "$3" =~ ^([1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])$ ]] || exit 1
# This runs only after the fixture has failed. Missing or unreadable private
# output must not replace its status or print the private pathname.
cat -- "$1" 2>/dev/null >> "$2" || true
node tests/support/search-admin-db-diagnostic.mjs "$1" "$3"
