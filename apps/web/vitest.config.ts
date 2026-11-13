import { defineConfig } from 'vitest/config';

/**
 * Тесты web — только чистые функции (`features/.../model`, `shared`), поэтому окружение node.
 * Рендер-тесты не добавляем: нет RTL/jsdom, дизайн не утверждён.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
