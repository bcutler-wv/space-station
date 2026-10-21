#!/bin/bash
set -euo pipefail

# SecurityAdmin 3.9.0.0 uploads these seven files unconditionally with -cd.
# It may also upload audit.yml and allowlist.yml if present; Station does not
# supply those optional policies in this fixed private profile.
if [[ $# -ne 1 || ! -d "$1" ]]; then
  echo 'Private search security manifest directory is invalid.' >&2
  exit 1
fi
directory="$1"
for name in config roles roles_mapping internal_users action_groups tenants nodes_dn; do
  if [[ ! -f "$directory/$name.yml" || ! -s "$directory/$name.yml" || ! -r "$directory/$name.yml" ]]; then
    echo "Private search security manifest is incomplete: $name.yml." >&2
    exit 1
  fi
done
for name in audit allowlist; do
  if [[ -e "$directory/$name.yml" || -L "$directory/$name.yml" ]]; then
    echo "Private search security manifest contains an unexpected policy: $name.yml." >&2
    exit 1
  fi
done
