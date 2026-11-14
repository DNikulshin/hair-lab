import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import {
  authRoutes,
  createMagicLinkTemplate,
  createTokenDeliveryRegistry,
  MAGIC_LINK_TYPE,
} from '../features/auth';
import {
  accountBookingsRoutes,
  bookingRoutes,
  createBookingCancellationTemplate,
  createBookingConfirmationTemplate,
  BOOKING_CANCELLATION_TYPE,
  BOOKING_CONFIRMATION_TYPE,
  type CreateBookingPaymentsOptions,
} from '../features/bookings';
import { catalogRoutes } from '../features/catalog';
import { healthRoutes } from '../features/health/health.routes';
import { createYookassaClient, paymentsPlugin, type PaymentGateway } from '../features/payments';
import { authPlugin, createOriginAllowList } from '../shared/auth';
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
 * Опции сборки: режим оплаты и шлюз подменяются в тестах, без мутации `process.env`.
 * Всё, что не передано, берётся из окружения (`shared/config/env`).
 */
export interface BuildServerOptions {
  payments?: {
    /** Включена ли оплата записи. По умолчанию — `PAYMENTS_MODE != 'off'`. */
    enabled?: boolean;
    /** Шлюз платежей. По умолчанию — клиент ЮKassa на ключах магазина из окружения. */
    gateway?: PaymentGateway;
  };
}

/**
 * Композиционный корень: здесь собирается сервер и регистрируются фичи.
 * Бизнес-логики в `app` нет. Фича — инкапсулированный Fastify-плагин.
 *
 * Реестр шаблонов писем собирается здесь же: `shared` не импортирует `features`,
 * поэтому плагин почты получает шаблоны опцией.
 */
export async function buildServer(options: BuildServerOptions = {}) {
  const paymentsEnabled = options.payments?.enabled ?? env.paymentsEnabled;
  // Шлюз создаётся один раз на процесс и только при включённой оплате: без ключей
  // магазина клиент ЮKassa бессмысленен, а в режиме `off` никто его не вызывает.
  const paymentGateway: PaymentGateway | null = paymentsEnabled
    ? (options.payments?.gateway ??
      createYookassaClient({
        shopId: env.YOOKASSA_SHOP_ID,
        secretKey: env.YOOKASSA_SECRET_KEY,
        apiUrl: env.YOOKASSA_API_URL,
      }))
    : null;
  const bookingPayments: CreateBookingPaymentsOptions | undefined =
    paymentGateway === null
      ? undefined
      : { gateway: paymentGateway, returnUrl: env.YOOKASSA_RETURN_URL };

  const app = Fastify({
    logger: createLoggerOptions(env),
    // API слушает только loopback, снаружи — nginx: настоящий IP клиента приходит
    // в X-Forwarded-For. Без доверия прокси rate limit считал бы все запросы одним IP
    // (адресом nginx), а настоящий адрес клиента терялся бы в логах.
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);

  const tokenDelivery = createTokenDeliveryRegistry();
  const emailTemplates: EmailTemplateRegistry = {
    [MAGIC_LINK_TYPE]: createMagicLinkTemplate({
      appUrl: env.APP_URL,
      fromName: env.SMTP_FROM_NAME,
      delivery: tokenDelivery,
    }),
    [BOOKING_CONFIRMATION_TYPE]: createBookingConfirmationTemplate({
      timezone: env.SALON_TIMEZONE,
      fromName: env.SMTP_FROM_NAME,
      fromEmail: env.SMTP_FROM_EMAIL,
    }),
    [BOOKING_CANCELLATION_TYPE]: createBookingCancellationTemplate({
      timezone: env.SALON_TIMEZONE,
      fromName: env.SMTP_FROM_NAME,
      fromEmail: env.SMTP_FROM_EMAIL,
    }),
  };

  await app.register(dbPlugin, { databaseUrl: env.DATABASE_URL });
  // Аутентификация после БД: плагину нужен `app.db` для резолва сессии из cookie.
  await app.register(authPlugin, {
    secureCookies: env.NODE_ENV === 'production',
    // CSRF-allowlist: сам сайт и источники, которым разрешены запросы к API.
    allowedOrigins: createOriginAllowList([env.APP_URL, ...env.CORS_ORIGINS.split(',')]),
  });
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
  await app.register(bookingRoutes, { payments: bookingPayments });
  await app.register(accountBookingsRoutes);
  // Оплата: маршруты и свипер истёкших холдов — только при включённом режиме.
  if (paymentGateway !== null) {
    await app.register(paymentsPlugin, {
      gateway: paymentGateway,
      sweepIntervalMs: env.PAYMENT_SWEEP_INTERVAL_MS,
    });
  }
  // `global: false`: лимиты задаются per-route в конфиге маршрута (см. auth.routes.ts).
  await app.register(rateLimit, { global: false });
  await app.register(authRoutes, { delivery: tokenDelivery });

  return app;
}

export type AppServer = Awaited<ReturnType<typeof buildServer>>;
