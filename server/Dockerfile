# --- build stage -------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# openssl is required by Prisma's query engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY server/package.json ./server/
RUN npm ci --workspace=server --include-workspace-root

COPY server ./server
RUN npm run db:generate --workspace=server \
    && npm run build --workspace=server

# --- runtime stage -----------------------------------------------------------
FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl curl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY server/package.json ./server/

# `prisma` is a runtime dependency here, not just a build tool: the container
# runs `prisma migrate deploy` on start, so pruning dev dependencies must not
# take the CLI with it. Moving it back to devDependencies breaks startup.
RUN npm ci --workspace=server --include-workspace-root --omit=dev

COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/server/dist ./server/dist
COPY server/prisma ./server/prisma

# Don't run the API as root.
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:4000/health || exit 1

WORKDIR /app/server
CMD ["node", "dist/index.js"]
