import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { ApiError, ApiErrorCode, ApiErrorDetail } from '@hair-lab/contracts';

const messages: Record<ApiErrorCode, string> = {
  validation_error: 'Некорректные данные запроса',
  unauthorized: 'Требуется авторизация',
  forbidden: 'Недостаточно прав',
  not_found: 'Не найдено',
  conflict: 'Конфликт состояния',
  slot_unavailable: 'Выбранное время уже занято',
  rate_limited: 'Слишком много запросов',
  internal_error: 'Внутренняя ошибка сервера',
};

const statusToCode: Record<number, ApiErrorCode> = {
  400: 'validation_error',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
};

function buildError(code: ApiErrorCode, requestId: string, details?: ApiErrorDetail[]): ApiError {
  return {
    error: {
      code,
      message: messages[code],
      requestId,
      ...(details && details.length > 0 ? { details } : {}),
    },
  };
}

/**
 * Единый формат ошибок для всех клиентов.
 * Наружу не уходят стектрейсы, тексты исключений и значения полей.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send(buildError('not_found', request.id)),
  );

  app.setErrorHandler((error: FastifyError | ZodError, request, reply) => {
    if (error instanceof ZodError) {
      request.log.warn({ requestId: request.id, issues: error.issues.length }, 'validation failed');
      const details: ApiErrorDetail[] = error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      return reply.status(400).send(buildError('validation_error', request.id, details));
    }

    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      // Стектрейс — только в лог, клиенту — нейтральное сообщение.
      request.log.error({ requestId: request.id, err: error }, 'unhandled error');
      return reply.status(500).send(buildError('internal_error', request.id));
    }

    const code = statusToCode[statusCode] ?? 'validation_error';
    request.log.warn({ requestId: request.id, statusCode, code }, 'request rejected');
    return reply.status(statusCode).send(buildError(code, request.id));
  });
}
