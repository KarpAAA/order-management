# One image, one process: the broker consumer (ops/process-model.md §1).
#   notifications: node dist/entrypoints/main.worker.js
# Build context: repository root (pnpm workspace + lockfile).

FROM node:24-slim AS base
RUN npm install --global pnpm@10.10.0
WORKDIR /repo

# ── build: full install, prisma generate, nest build ─────────────────────────
# Also used as-is by the one-shot `migrate-notifications` compose service (it has the Prisma CLI).
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# patchedDependencies in pnpm-workspace.yaml: the install fails when a patch file is missing
COPY patches patches
# the message contracts are a workspace dependency, consumed from their dist (docs/adr/0011)
COPY packages/contracts/package.json packages/contracts/
COPY services/notifications/package.json services/notifications/
RUN pnpm install --frozen-lockfile --filter @oms/notifications...
COPY packages/contracts packages/contracts
COPY services/notifications services/notifications
# prisma.config.ts resolves DATABASE_ADMIN_URL even for `generate`; any syntactically valid URL works.
ENV DATABASE_ADMIN_URL=postgresql://build:build@localhost:5432/build
# The workspace patches a dev dependency of the api (pnpm-workspace.yaml). This service does
# not have it, and `deploy` fails on a patch it did not apply unless told otherwise.
RUN pnpm --filter @oms/contracts build \
 && pnpm --filter @oms/notifications build \
 && pnpm --config.allowUnusedPatches=true --filter @oms/notifications deploy --prod --legacy /out

# ── runtime: production deps + compiled code, non-root ───────────────────────
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /repo/services/notifications/dist ./dist
USER node
# the tracing is loaded before the application, or it patches nothing (docs/adr/0025)
CMD ["node", "--require", "./dist/instrumentation.js", "dist/entrypoints/main.worker.js"]
