ARG BASE
FROM ${BASE}
ARG MODE
USER root
RUN mv /app/packages/search/dist/opensearch-runtime.js /app/packages/search/dist/opensearch-runtime-original.js \
 && mv /app/scripts/search-writer-role-consumer-core.mjs /app/scripts/search-writer-role-consumer-core-original.mjs
COPY --chown=1000:1000 tests/integration/search-writer-role-delivery-runtime-wrapper.mjs /app/packages/search/dist/opensearch-runtime.js
COPY --chown=1000:1000 tests/integration/search-writer-role-delivery-core-wrapper.mjs /app/scripts/search-writer-role-consumer-core.mjs
COPY --chown=1000:1000 tests/integration/search-writer-role-delivery-transport.mjs /app/scripts/search-writer-role-delivery-transport.mjs
RUN printf '%s' "$MODE" > /app/writer-delivery-fixture-mode && chmod 0444 /app/writer-delivery-fixture-mode
