/**
 * Публичный API модуля БД: клиент Prisma и Fastify-плагин.
 * Импортировать только из серверного кода `apps/api`.
 */
export { createPrismaClient, type Db } from './client';
export { sqlStateOf } from './errors';
export { default as dbPlugin, type DbPluginOptions } from './plugin';
