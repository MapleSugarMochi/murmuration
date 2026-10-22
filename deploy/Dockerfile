# syntax=docker/dockerfile:1.7
# One image serves the API, WebSockets and the built web app.

FROM node:22.11-alpine AS build
WORKDIR /app
# Not corepack: the one bundled with this Node release can no longer verify
# npm's rotated signing keys.
RUN npm install -g pnpm@9.15.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/doc-model/package.json packages/doc-model/
COPY packages/protocol/package.json packages/protocol/
COPY packages/room/package.json packages/room/
COPY packages/sync-client/package.json packages/sync-client/
COPY packages/renderer/package.json packages/renderer/
COPY tools/sim/package.json tools/sim/
COPY tools/loadtest/package.json tools/loadtest/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @tandem/web build && pnpm --filter @tandem/server build
# Production dependencies of the server only, as a flat node_modules.
RUN pnpm --filter @tandem/server deploy --prod /out

FROM node:22.11-alpine
ENV NODE_ENV=production PORT=8080 PUBLIC_DIR=/app/public
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/web/dist ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]
