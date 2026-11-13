import { baseConfig, webExtras } from '@hair-lab/eslint-config';

export default [
  ...baseConfig,
  { files: ['apps/web/**/*.{ts,tsx}'], ...webExtras },
  {
    // CLI-скрипты репозитория: их единственный вывод — прогресс и ошибки для человека.
    // Правило `no-console` из базового набора здесь не применимо (issue #52).
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
];
