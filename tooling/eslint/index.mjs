import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Базовый набор правил для всех пакетов монорепо.
 * Границы слоёв проверяет `pnpm check:arch`, а не линтер.
 * @type {import('eslint').Linter.Config[]}
 */
export const baseConfig = tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
);

/**
 * Дополнение для кода, который исполняется в браузере (apps/web).
 * @type {import('eslint').Linter.Config}
 */
export const webExtras = {
  languageOptions: {
    globals: { ...globals.browser, ...globals.es2023 },
  },
};
