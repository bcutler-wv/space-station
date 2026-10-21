#!/bin/bash
set -euo pipefail

# The security index is not initialized yet, so an authenticated HTTP health
# check would deadlock bootstrap. Wait only for the private TLS port here.
deadline=$((SECONDS + 120))
while ! timeout 2 bash -c 'echo >/dev/tcp/opensearch/9200' 2>/dev/null; do
  if (( SECONDS >= deadline )); then
    echo 'Private search TLS port did not become ready.' >&2
    exit 1
  fi
  sleep 1
done

phase="$(cat /run/station-state/phase)"
probe() {
  curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 2 --max-time 5 \
    --cacert /run/station-admin/ca.pem \
    --cert /run/station-admin/admin.pem --key /run/station-admin/admin.key \
    https://opensearch:9200/_plugins/_security/api/securityconfig
}
case "$phase" in
  ready)
    test "$(probe)" = 200 || { echo 'Retained search security is unavailable.' >&2; exit 1; }
    echo 'Retained private search security found; initialization skipped.'
    ;;
  fresh)
    # Do this before changing the durable phase or uploading any config. A
    # partial directory upload would otherwise strand the retained index.
    bash /run/station-security-config/check-manifest.sh /run/station-security-config
    # An existing security index with a fresh marker is inconsistent. Never
    # overwrite it with bootstrap YAML, even if a previous attempt crashed.
    status="$(probe || true)"
    test "$status" != 200 || { echo 'Search security state is inconsistent.' >&2; exit 1; }
    printf 'attempting\n' > /run/station-state/phase
    timeout --signal=TERM --kill-after=5s 120s \
      /usr/share/opensearch/plugins/opensearch-security/tools/securityadmin.sh \
      -cd /run/station-security-config -h opensearch -p 9200 \
      -cn station-private-search \
      -cacert /run/station-admin/ca.pem \
      -cert /run/station-admin/admin.pem \
      -key /run/station-admin/admin.key
    test "$(probe)" = 200 || { echo 'Search security initialization was not observed.' >&2; exit 1; }
    printf 'ready\n' > /run/station-state/phase
    ;;
  *) echo 'Search security initialization state is incomplete.' >&2; exit 1;;
esac
