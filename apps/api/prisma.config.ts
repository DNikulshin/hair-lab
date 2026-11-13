import { defineConfig } from 'prisma/config';

/**
 * Конфигурация Prisma 7: строка подключения живёт здесь, а не в `schema.prisma`
 * (`url` в схеме запрещён). Значение берётся из окружения, в репозиторий не попадает.
 * Запуск: `DATABASE_URL=... pnpm --filter @hair-lab/api db:migrate:dev`.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
});
