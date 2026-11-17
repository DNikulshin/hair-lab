import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { createPrismaClient, type Db } from './client';

declare module 'fastify' {
  interface FastifyInstance {
    /** Клиент БД. Доступен фичам через декоратор, закрывается при `app.close()`. */
    db: Db;
  }
}

export interface DbPluginOptions {
  databaseUrl: string;
  /**
   * Готовый клиент БД. Подменяется в тестах композиции, без сети: тогда соединение
   * по `databaseUrl` не открывается. По умолчанию клиент создаётся из `databaseUrl`.
   */
  client?: Db;
}

/**
 * Плагин БД: создаёт единственный клиент на приложение (или берёт переданный)
 * и закрывает соединения при остановке сервера (main.ts вызывает `app.close()`
 * по SIGINT/SIGTERM). `fastify-plugin` нужен, чтобы декоратор был виден
 * в родительском контексте.
 */
const dbPlugin: FastifyPluginAsync<DbPluginOptions> = async (app, options) => {
  const db = options.client ?? createPrismaClient(options.databaseUrl);

  app.decorate('db', db);
  app.addHook('onClose', async () => {
    await db.$disconnect();
  });
};

export default fp(dbPlugin, { name: 'db' });
