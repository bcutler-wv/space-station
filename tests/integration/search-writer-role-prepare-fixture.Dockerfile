ARG BASE
FROM ${BASE}
USER root
RUN mv /app/scripts/search-writer-role-prepare.mjs /app/scripts/search-writer-role-prepare-original.mjs
COPY --chown=1000:1000 tests/integration/search-writer-role-prepare-fixture-sdk.mjs /app/scripts/search-writer-role-prepare.mjs
COPY --chown=1000:1000 tests/integration/search-writer-role-prepare-fixture-probe.mjs /app/scripts/search-writer-role-prepare-fixture-probe.mjs
