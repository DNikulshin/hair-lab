/**
 * Публичный API пакета контрактов.
 *
 * Правила (см. AGENTS.md и README.md пакета):
 * - источник истины — Zod-схемы, типы выводятся через `z.infer`;
 * - только чистый TypeScript и Zod: без `node:*`, DOM, React, Fastify;
 * - изменения только обратно совместимые.
 *
 * Приложения импортируют только `@hair-lab/contracts` (без глубоких путей).
 */
export * from './booking/booking.contract';
export * from './catalog/catalog.contract';
export * from './common/errors';
export * from './common/ids';
export * from './common/money';
export * from './common/pagination';
export * from './common/time';
export * from './health/health.contract';
