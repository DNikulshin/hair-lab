import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
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

/** Сообщение по полю, если провайдер не приложил текст к ошибке. */
const DEFAULT_DETAIL_MESSAGE = 'Некорректное значение';

const statusToCode: Record<number, ApiErrorCode> = {
  400: 'validation_error',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
};

/**
 * Тело ошибки в едином формате. Экспортируется, чтобы фича могла вернуть специфичный код
 * (`slot_unavailable`), который не выводится из HTTP-статуса.
 */
export function buildError(
  code: ApiErrorCode,
  requestId: string,
  details?: ApiErrorDetail[],
): ApiError {
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
 * Путь поля из ошибки валидации провайдера: `instancePath` (`/clientPhone`, `/items/0/name`)
 * приводится к виду `clientPhone` / `items.0.name`, по которому клиент находит поле формы.
 */
function detailPath(instancePath: string): string {
  return instancePath.replace(/^\/+/, '').split('/').join('.');
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

    // `fastify-type-provider-zod` не бросает `ZodError`: его `validatorCompiler` возвращает
    // ошибку валидации Fastify с массивом `validation` (по элементу на issue). Форма отличается,
    // поэтому распознаём её предикатом пакета, иначе 400 уходит без `details`.
    // В `details` попадают только путь поля и текст схемы: значения полей (ПДн) там не выводятся.
    if (hasZodFastifySchemaValidationErrors(error)) {
      request.log.warn(
        { requestId: request.id, issues: error.validation.length },
        'validation failed',
      );
      const details: ApiErrorDetail[] = error.validation.map((issue) => ({
        path: detailPath(issue.instancePath),
        message: issue.message ?? DEFAULT_DETAIL_MESSAGE,
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
