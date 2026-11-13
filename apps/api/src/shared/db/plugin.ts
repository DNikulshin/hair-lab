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
}

/**
 * Плагин БД: создаёт единственный клиент на приложение и закрывает соединения
 * при остановке сервера (main.ts вызывает `app.close()` по SIGINT/SIGTERM).
 * `fastify-plugin` нужен, чтобы декоратор был виден в родительском контексте.
 */
const dbPlugin: FastifyPluginAsync<DbPluginOptions> = async (app, options) => {
  const db = createPrismaClient(options.databaseUrl);

  app.decorate('db', db);
  app.addHook('onClose', async () => {
    await db.$disconnect();
  });
};

export default fp(dbPlugin, { name: 'db' });
