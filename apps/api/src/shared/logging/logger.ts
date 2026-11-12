import type { FastifyServerOptions } from 'fastify';
import type { Env } from '../config/env';

/**
 * Логи структурированные (pino). В development — человекочитаемо.
 * Персональные данные в логи не попадают: телефоны и email маскируются на месте вызова.
 */
export function createLoggerOptions(env: Env): FastifyServerOptions['logger'] {
  if (env.NODE_ENV === 'development') {
    return {
      level: env.LOG_LEVEL,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    };
  }
  return { level: env.LOG_LEVEL };
}
