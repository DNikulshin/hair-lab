import { defineConfig } from 'vitest/config';

/**
 * Интеграционные тесты: требуют поднятого PostgreSQL и заполненного `.env`.
 * Запускаются отдельной командой `pnpm test:int`, в CI — отдельной стадией.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.int.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Последовательный запуск: интеграционные тесты работают с общей БД.
    fileParallelism: false,
  },
});
