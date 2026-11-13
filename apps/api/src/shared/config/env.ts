import { z } from 'zod';

/**
 * Конфигурация читается один раз при старте. Валидация на границе:
 * приложение не должно запускаться с невалидным окружением.
 *
 * Почта (SMTP) — необязательная интеграция: пустой `SMTP_HOST` означает «письма выключены»,
 * API при этом работает. Остальные поля SMTP проверяются только когда хост заполнен.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    SALON_TIMEZONE: z.string().min(1).default('Europe/Moscow'),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    // Базовый адрес сайта: ссылки в письмах и возвраты после оплаты.
    APP_URL: z.string().min(1).default('http://localhost:3000'),
    // Строка подключения к PostgreSQL. В тексте ошибки — только имя поля, без значения.
    DATABASE_URL: z
      .string()
      .min(1)
      .refine((value) => value.startsWith('postgresql://'), {
        message: 'ожидается строка подключения postgresql://',
      }),

    // Пусто — почта выключена (диспетчер outbox не стартует).
    SMTP_HOST: z.string().trim().default(''),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(465),
    // Строка, а не boolean: `Boolean('false') === true` — тихая ошибка конфигурации.
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    SMTP_USER: z.string().trim().default(''),
    // Секрет. В текст ошибки валидации не попадает — только имя поля.
    SMTP_PASSWORD: z.string().default(''),
    // Пусто — берётся `SMTP_USER` (см. transform ниже).
    SMTP_FROM_EMAIL: z.string().trim().default(''),
    SMTP_FROM_NAME: z.string().trim().default('Стриж Lab'),
  })
  .superRefine((value, ctx) => {
    // Без хоста интеграция выключена: остальные поля не проверяем, чтобы пустой шаблон .env
    // оставался валидным. Заполненный хост без логина/пароля — ошибка старта.
    if (value.SMTP_HOST === '') return;
    const required = ['SMTP_USER', 'SMTP_PASSWORD'] as const;
    for (const field of required) {
      if (value[field] === '') {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'обязательно при заполненном SMTP_HOST',
        });
      }
    }
  })
  .transform((value) => ({
    ...value,
    // Адрес отправителя по умолчанию совпадает с логином ящика.
    SMTP_FROM_EMAIL: value.SMTP_FROM_EMAIL === '' ? value.SMTP_USER : value.SMTP_FROM_EMAIL,
    /** Выключатель модуля почты: без хоста писать и отправлять письма некуда. */
    emailEnabled: value.SMTP_HOST !== '',
  }));

export type Env = z.infer<typeof envSchema>;

/** Разбор окружения. В тексте ошибки — только имена полей, без значений. */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
    throw new Error(`Некорректное окружение: ${fields}`);
  }
  return result.data;
}

export const env: Env = parseEnv();
