# syntax=docker/dockerfile:1

# Образ web: Next.js standalone. NEXT_PUBLIC_* встраиваются в бандл на этапе сборки,
# поэтому бренд передаётся build-arg'ами (значения — из workflow или из CI-переменных).
#
# Слои разделены намеренно: `deps` копирует только манифесты воркспейса, поэтому слой
# `pnpm install` переиспользуется, пока не изменились lockfile или package.json пакетов.
FROM node:26-alpine AS base
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
# NEXT_PUBLIC_* должны быть заданы до `next build`: значения встраиваются в клиентский бандл.
ARG NEXT_PUBLIC_SITE_NAME
ARG NEXT_PUBLIC_SITE_SHORT_NAME
ARG NEXT_PUBLIC_SITE_DESCRIPTION
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_SITE_CITY
ARG NEXT_PUBLIC_SITE_TIMEZONE
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_SITE_NAME=$NEXT_PUBLIC_SITE_NAME \
    NEXT_PUBLIC_SITE_SHORT_NAME=$NEXT_PUBLIC_SITE_SHORT_NAME \
    NEXT_PUBLIC_SITE_DESCRIPTION=$NEXT_PUBLIC_SITE_DESCRIPTION \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_SITE_CITY=$NEXT_PUBLIC_SITE_CITY \
    NEXT_PUBLIC_SITE_TIMEZONE=$NEXT_PUBLIC_SITE_TIMEZONE \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_TELEMETRY_DISABLED=1

# Исходники только того, что нужно web: общий тулинг, контракты и сам пакет.
COPY tooling tooling
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN pnpm --filter @hair-lab/contracts build \
 && pnpm --filter @hair-lab/web build

FROM node:26-alpine AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]
