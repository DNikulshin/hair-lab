/**
 * Разбор ошибок драйвера БД.
 *
 * Prisma 7 с драйвер-адаптером `pg` не отдаёт SQLSTATE в `error.code`: код Postgres
 * прокидывается в `meta.driverAdapterError`. Хелпер нужен и серверному коду
 * (маппинг нарушения EXCLUDE/UNIQUE в ответ 409), и интеграционным тестам.
 */
export function sqlStateOf(error: unknown): string | undefined {
  const meta = (error as { meta?: { driverAdapterError?: { cause?: unknown } } } | undefined)?.meta;
  const cause = meta?.driverAdapterError?.cause as
    { originalCode?: string; code?: string; kind?: string } | undefined;
  return cause?.originalCode ?? cause?.code;
}
