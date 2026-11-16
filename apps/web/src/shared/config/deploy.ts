/**
 * Информация о стенде для плашки на странице (issue #170).
 *
 * Значения приходят в контейнер `web` как runtime-переменные (`DEPLOY_ENV`, `DEPLOY_SHA`,
 * `DEPLOY_AT`), а не build-args: один и тот же образ из GHCR живёт и на preprod, и на проде,
 * поэтому решать «показывать плашку или нет» нужно в момент запуска контейнера, а не сборки.
 * Прод и локальная разработка переменных не задают — плашки нет вообще (см. `docs/staging.md`).
 *
 * Секретов здесь быть не может: всё это видно в браузере. SHA и время деплоя публичны и так
 * (они есть в Actions и в `.deployed-sha`).
 */

/** Окружения, на которых плашка показывается. Прод сюда сознательно не входит. */
export const DEPLOY_ENVS = ['staging', 'preprod'] as const;

export type DeployEnv = (typeof DEPLOY_ENVS)[number];

export type DeployInfo = {
  env: DeployEnv;
  /** Короткий sha задеплоенного коммита; `null`, если он не передан или не похож на sha. */
  sha: string | null;
  /** Момент деплоя; `null`, если время не передано или не разбирается. */
  at: Date | null;
};

/** Длина короткого sha: столько же, сколько показывает `git log --oneline`. */
const SHORT_SHA_LENGTH = 7;

/**
 * Приводит окружение к известному значению. Неизвестное (в том числе пустое и `production`)
 * означает «плашку не показывать»: лучше ничего, чем неверная метка на проде.
 * @param value значение переменной `DEPLOY_ENV`
 * @returns окружение стенда или `null`
 */
export function normalizeDeployEnv(value: string | undefined): DeployEnv | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  return DEPLOY_ENVS.find((env) => env === normalized) ?? null;
}

/**
 * Короткий sha из значения переменной: полный (40) или короткий (≥7 hex). Всё остальное —
 * `null`: переменная приходит из скрипта деплоя, но плашка не должна печатать мусор.
 * @param value значение переменной `DEPLOY_SHA`
 * @returns короткий sha или `null`
 */
export function normalizeDeploySha(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !/^[0-9a-f]{7,40}$/.test(normalized)) return null;
  return normalized.slice(0, SHORT_SHA_LENGTH);
}

/**
 * Момент деплоя из ISO-8601. Пустое или неразбираемое значение — `null`: часы тогда
 * стартуют с текущего времени, а не с «неверного 1970».
 * @param value значение переменной `DEPLOY_AT`
 * @returns дата или `null`
 */
export function normalizeDeployAt(value: string | undefined): Date | null {
  const raw = value?.trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Собирает информацию о стенде из окружения контейнера.
 * @param env окружение процесса (в тестах подменяется)
 * @returns данные для плашки или `null`, если это не стенд
 */
export function readDeployInfo(
  env: Record<string, string | undefined> = process.env,
): DeployInfo | null {
  const deployEnv = normalizeDeployEnv(env.DEPLOY_ENV);
  if (deployEnv === null) return null;

  return {
    env: deployEnv,
    sha: normalizeDeploySha(env.DEPLOY_SHA),
    at: normalizeDeployAt(env.DEPLOY_AT),
  };
}

/** Часовой пояс салона: время на плашке показываем в нём, а не в UTC. */
export const DISPLAY_TIME_ZONE = 'Europe/Moscow';

const TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  timeZone: DISPLAY_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  timeZone: DISPLAY_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * Время часов на плашке: `14:09:05` в часовом поясе салона.
 * @param date момент времени
 * @returns строка времени
 */
export function formatClock(date: Date): string {
  return TIME_FORMATTER.format(date);
}

/**
 * Время деплоя: `16.11 14:09` в часовом поясе салона.
 * @param date момент деплоя
 * @returns строка «дата и время»
 */
export function formatDeployMoment(date: Date): string {
  return DATE_TIME_FORMATTER.format(date);
}
