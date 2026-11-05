ARG BASE
FROM ${BASE}
USER root
RUN mv /app/scripts/search-writer-mapping-prepare.mjs /app/scripts/search-writer-mapping-prepare-original.mjs
COPY --chown=1000:1000 tests/integration/search-writer-mapping-prepare-fixture-sdk.mjs /app/scripts/search-writer-mapping-prepare.mjs
COPY --chown=1000:1000 tests/integration/search-writer-mapping-prepare-fixture-probe.mjs /app/scripts/search-writer-mapping-prepare-fixture-probe.mjs
