ARG BASE
FROM ${BASE}
ARG MODE
USER root
RUN mv /app/packages/search/dist/opensearch-runtime.js /app/packages/search/dist/opensearch-runtime-original.js \
 && mv /app/scripts/search-writer-mapping-consumer-core.mjs /app/scripts/search-writer-mapping-consumer-core-original.mjs
COPY --chown=1000:1000 tests/integration/search-writer-mapping-delivery-runtime-wrapper.mjs /app/packages/search/dist/opensearch-runtime.js
COPY --chown=1000:1000 tests/integration/search-writer-mapping-delivery-core-wrapper.mjs /app/scripts/search-writer-mapping-consumer-core.mjs
COPY --chown=1000:1000 tests/integration/search-writer-mapping-delivery-transport.mjs /app/scripts/search-writer-mapping-delivery-transport.mjs
RUN printf '%s' "$MODE" > /app/writer-mapping-delivery-fixture-mode && chmod 0444 /app/writer-mapping-delivery-fixture-mode
