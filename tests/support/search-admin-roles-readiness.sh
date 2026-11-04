#!/usr/bin/env bash

# The image entrypoint exposes a socket-only temporary server before POSTGRES_DB
# exists. A successful query over final TCP is the sole migration prerequisite.
search_admin_roles_wait_ready() {
  local container=$1 attempt ready
  for attempt in {1..30}; do
    if ready=$(docker exec "$container" sh -c \
      'PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=3 PGOPTIONS="-c statement_timeout=3000" exec psql -X -w -h 127.0.0.1 -p 5432 -U station -d station -v ON_ERROR_STOP=1 -Atqc "SELECT 1"' \
      2>/dev/null) && [[ $ready == 1 ]]; then
      return 0
    fi
    if [[ $attempt == 30 ]]; then
      echo 'Disposable PG16 did not become ready.' >&2
      return 1
    fi
    sleep 1
  done
}
