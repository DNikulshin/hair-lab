# syntax=docker/dockerfile:1

# Образ API: сборка контрактов и API, затем перенос только production-зависимостей.
FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --filter @hair-lab/contracts build \
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
