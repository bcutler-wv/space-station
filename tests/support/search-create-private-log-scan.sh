#!/usr/bin/env bash

# The gate calls this after its final teardown command, with markers captured
# before deleting the disposable checkout. Tests exercise this exact function.
scan_create_private_log_after_teardown() {
  local runner_root=$1 marker_file=$2 private_log=$3 use_sudo=$4
  if [[ $use_sudo == yes ]]; then
    (cd "$runner_root" && sudo "$(command -v node)" \
      tests/support/search-create-private-log-scan.mjs --scan "$marker_file" "$private_log")
  elif [[ $use_sudo == no ]]; then
    (cd "$runner_root" && "$(command -v node)" \
      tests/support/search-create-private-log-scan.mjs --scan "$marker_file" "$private_log")
  else
    return 1
  fi
}
