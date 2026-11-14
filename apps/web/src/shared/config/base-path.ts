/**
 * Базовый путь приложения при работе за reverse proxy (dev-прокси code-server).
 *
 * Нормализация та же, что в `next.config.ts`: `undefined`/пусто/`/` → пустая строка,
 * иначе гарантируются ведущий `/` и отсутствие хвостового. Сознательное дублирование:
 * `next.config.ts` резолвит модули только как CommonJS и не импортирует код из `src/`,
 * поэтому общий хелпер вынесен сюда, а конфиг оставлен без изменений.
 *
 * Возвращаем строку (а не `undefined`), потому что вызывающий код склеивает пути:
 * `${base}/offline`. В проде база пустая — PWA рассчитана на работу от корня.
 */
export function normalizeBasePath(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw || raw === '/') return '';
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/+$/, '');
}
