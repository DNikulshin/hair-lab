import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import {
  bookingRoutes,
  createBookingConfirmationTemplate,
  BOOKING_CONFIRMATION_TYPE,
} from '../features/bookings';
import { catalogRoutes } from '../features/catalog';
import { healthRoutes } from '../features/health/health.routes';
import { env } from '../shared/config/env';
import { dbPlugin } from '../shared/db';
import {
  createPrismaOutboxStore,
  createSmtpTransport,
  emailPlugin,
  type EmailTemplateRegistry,
} from '../shared/email';
import { registerErrorHandler } from '../shared/http/error-handler';
import { createLoggerOptions } from '../shared/logging/logger';

/**
 * Композиционный корень: здесь собирается сервер и регистрируются фичи.
 * Бизнес-логики в `app` нет. Фича — инкапсулированный Fastify-плагин.
 *
 * Реестр шаблонов писем собирается здесь же: `shared` не импортирует `features`,
 * поэтому плагин почты получает шаблоны опцией.
 */
export async function buildServer() {
  const app = Fastify({ logger: createLoggerOptions(env) }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);

  const emailTemplates: EmailTemplateRegistry = {
    [BOOKING_CONFIRMATION_TYPE]: createBookingConfirmationTemplate({
      timezone: env.SALON_TIMEZONE,
      fromName: env.SMTP_FROM_NAME,
      fromEmail: env.SMTP_FROM_EMAIL,
    }),
  };

  await app.register(dbPlugin, { databaseUrl: env.DATABASE_URL });
  await app.register(emailPlugin, {
    enabled: env.emailEnabled,
    templates: emailTemplates,
    // Хранилище и транспорт создаются только при включённой почте.
    createStore: () => createPrismaOutboxStore(app.db),
    createTransport: () =>
      createSmtpTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        fromEmail: env.SMTP_FROM_EMAIL,
        fromName: env.SMTP_FROM_NAME,
      }),
  });
  await app.register(healthRoutes);
  await app.register(catalogRoutes);
  await app.register(bookingRoutes);

  return app;
}

export type AppServer = Awaited<ReturnType<typeof buildServer>>;
