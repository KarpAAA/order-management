# One image, two processes: the command picks the entrypoint (ops/process-model.md §1).
#   api:    node dist/entrypoints/main.api.js
#   worker: node dist/entrypoints/main.worker.js
# Build context: repository root (pnpm workspace + lockfile).

FROM node:24-slim AS base
RUN npm install --global pnpm@10.10.0
WORKDIR /repo

# ── build: full install, prisma generate, nest build ─────────────────────────
# Also used as-is by the one-shot `migrate` compose service (it has the Prisma CLI).
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# patchedDependencies in pnpm-workspace.yaml: the install fails when a patch file is missing
COPY patches patches
COPY services/api/package.json services/api/
RUN pnpm install --frozen-lockfile --filter @oms/api...
COPY services/api services/api
# prisma.config.ts resolves DATABASE_URL even for `generate`; any syntactically valid URL works.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN pnpm --filter @oms/api build \
 && pnpm --filter @oms/api deploy --prod --legacy /out

# ── runtime: production deps + compiled code, non-root ───────────────────────
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /repo/services/api/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/entrypoints/main.api.js"]
