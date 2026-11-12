import { z } from 'zod';

/**
 * Конфигурация читается один раз при старте. Валидация на границе:
 * приложение не должно запускаться с невалидным окружением.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SALON_TIMEZONE: z.string().min(1).default('Europe/Moscow'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
});

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
