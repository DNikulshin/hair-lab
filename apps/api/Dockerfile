# syntax=docker/dockerfile:1

# Образ API: сборка контрактов и API, затем перенос только production-зависимостей.
#
# Слои разделены намеренно: `deps` копирует только манифесты воркспейса, поэтому слой
# `pnpm install` переиспользуется, пока не изменились lockfile или package.json пакетов.
# Правка исходников в `deps` не попадает и установку не инвалидирует.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS deps
# Все воркспейс-пакеты из pnpm-workspace.yaml: без их манифестов `--frozen-lockfile` не пройдёт.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY tooling/eslint/package.json tooling/eslint/
COPY tooling/prettier/package.json tooling/prettier/
COPY tooling/tsconfig/package.json tooling/tsconfig/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
# Исходники только того, что нужно api: общий тулинг, контракты и сам пакет.
COPY tooling tooling
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @hair-lab/contracts build \
 && pnpm --filter @hair-lab/api db:generate \
 && pnpm --filter @hair-lab/api build \
 && pnpm --filter @hair-lab/api deploy --prod /out

FROM node:22-alpine AS runner
ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
WORKDIR /app
# `pnpm deploy` уже содержит dist и только production-зависимости.
COPY --from=build /out ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${API_PORT:-3001}/health" >/dev/null || exit 1
CMD ["node", "dist/main.js"]
