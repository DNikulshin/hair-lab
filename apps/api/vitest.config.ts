import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Unit-тесты в БД не ходят, но конфигурация требует DATABASE_URL:
    // подставляем заведомо фиктивное значение (проверяется только префикс).
    env: { DATABASE_URL: 'postgresql://unit_test:unit_test@127.0.0.1:5432/unit_test' },
  },
});
