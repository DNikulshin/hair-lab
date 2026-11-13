import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { healthRoutes } from '../features/health/health.routes';
import { env } from '../shared/config/env';
import { dbPlugin } from '../shared/db';
import { registerErrorHandler } from '../shared/http/error-handler';
import { createLoggerOptions } from '../shared/logging/logger';

/**
 * Композиционный корень: здесь собирается сервер и регистрируются фичи.
 * Бизнес-логики в `app` нет. Фича — инкапсулированный Fastify-плагин.
 */
export async function buildServer() {
  const app = Fastify({ logger: createLoggerOptions(env) }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);

  await app.register(dbPlugin, { databaseUrl: env.DATABASE_URL });
  await app.register(healthRoutes);

  return app;
}

export type AppServer = Awaited<ReturnType<typeof buildServer>>;
