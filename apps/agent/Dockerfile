# syntax=docker/dockerfile:1.7

# ---- Build stage ---------------------------------------------------------
FROM node:20-alpine AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /repo
# Copy workspace manifests first for layer caching
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/agent/package.json ./apps/agent/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch

COPY packages/shared ./packages/shared
COPY apps/agent ./apps/agent

RUN pnpm install --frozen-lockfile --offline
# Build shared FIRST so its dist/ exists when the agent's tsc resolves
# '@depf/shared' via package.json main. Without this, the agent's
# compiled output references a TS source file Node 20 can't load.
RUN pnpm --filter @depf/shared build
RUN pnpm --filter @depf/agent build

# ---- Runtime stage -------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY --from=build /repo/pnpm-workspace.yaml /repo/package.json /repo/pnpm-lock.yaml ./
COPY --from=build /repo/packages/shared ./packages/shared
COPY --from=build /repo/apps/agent/package.json ./apps/agent/
COPY --from=build /repo/apps/agent/dist ./apps/agent/dist
COPY --from=build /repo/apps/agent/migrations ./apps/agent/migrations

# Install only production dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

EXPOSE 3200
# Default command runs the HTTP server. For the BullMQ worker process, run
# the same image with: CMD ["node", "apps/agent/dist/workers/message-worker.js"]
CMD ["node", "apps/agent/dist/server/index.js"]
