FROM node:22.23.2-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN corepack pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store
RUN corepack pnpm build

FROM node:22.23.2-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /app /app
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/main.js"]

# The attestor alone needs OpenSSL's full sslclient purpose checks. The final
# default stage still inherits runtime, without this package installation.
FROM runtime AS search-attestor
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl=3.0.22-1~deb12u1 libssl3=3.0.22-1~deb12u1 \
    && test "$(dpkg-query -W -f='${Version}' openssl)" = '3.0.22-1~deb12u1' \
    && test "$(dpkg-query -W -f='${Version}' libssl3)" = '3.0.22-1~deb12u1' \
    && rm -rf /var/lib/apt/lists/*
USER node

FROM runtime
