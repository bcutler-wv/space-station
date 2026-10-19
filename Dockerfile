FROM node:22.23.2-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN corepack pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store
RUN corepack pnpm build

FROM node:22.23.2-bookworm-slim
WORKDIR /app
COPY --from=build /app /app
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/main.js"]
