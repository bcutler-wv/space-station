#!/bin/sh
set -eu

case "${SEARCH_APP_GID:-}" in ''|*[!0-9]*) exit 1;; esac
test "$SEARCH_APP_GID" -ge 1
test "$SEARCH_APP_GID" -le 65535

data_count="$(find /search-data -mindepth 1 -maxdepth 1 | wc -l)"
install -d -m 0700 -o 1000 -g 1000 /search-data
chown -R 1000:1000 /search-config
install -d -m 0770 -o 0 -g 1000 /state
if test -f /state/phase; then
  case "$(cat /state/phase)" in
    ready) ;;
    fresh) test "$data_count" -eq 0 || { echo 'Incomplete private search initialization.' >&2; exit 1; } ;;
    *) echo 'Incomplete private search initialization.' >&2; exit 1;;
  esac
else
  test "$data_count" -eq 0 && test "$(find /state -mindepth 1 -maxdepth 1 | wc -l)" -eq 0 || {
    echo 'Private search data exists without its initialization state.' >&2; exit 1;
  }
  install -m 0660 -o 0 -g 1000 /dev/null /state/phase
  printf 'fresh\n' > /state/phase
fi
copy_role() {
  role="$1" target="$2" group="$3"
  install -d -m 0750 -o 0 -g "$group" "$target"
  count="$(find "$target" -mindepth 1 -maxdepth 1 | wc -l)"
  test "$count" -eq 0 || test "$count" -eq 3 || {
    echo 'Private search role volume is incomplete.' >&2; exit 1;
  }
  for file in ca.pem "$role.pem" "$role.key"; do
    source="/source/$file"
    if test "$count" -eq 3; then
      test -f "$target/$file" && cmp -s "$source" "$target/$file" || {
        echo 'Private search identity changed or is incomplete.' >&2; exit 1;
      }
    else
      install -m 0440 -o 0 -g "$group" "$source" "$target/$file"
    fi
  done
  test "$(find "$target" -mindepth 1 -maxdepth 1 | wc -l)" -eq 3
  chmod 0750 "$target"
}
copy_role node /node 1000
copy_role admin /admin 1000
copy_role query /query "$SEARCH_APP_GID"
copy_role indexer /indexer "$SEARCH_APP_GID"
copy_role outsider /outsider "$SEARCH_APP_GID"
