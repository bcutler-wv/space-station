ARG BASE
FROM ${BASE}
USER root
RUN cp /app/scripts/search-create-apply-consumer-core.mjs /app/scripts/search-create-apply-consumer-core-original.mjs \
 && cp /app/packages/search/dist/opensearch-create-index.js /app/packages/search/dist/opensearch-create-index-original.js
COPY tests/integration/search-create-apply-fixture-core.mjs /app/scripts/search-create-apply-consumer-core.mjs
COPY tests/integration/search-create-apply-fixture-sdk.mjs /app/packages/search/dist/opensearch-create-index.js
COPY tests/support/search-create-apply-gate-transport.mjs /app/packages/search/dist/opensearch-create-fixture-transport.js
ARG MODE
RUN printf '%s' "$MODE" > /app/create-apply-fixture-mode \
 && chmod 0444 /app/create-apply-fixture-mode
