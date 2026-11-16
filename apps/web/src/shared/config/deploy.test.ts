import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatDeployMoment,
  normalizeDeployAt,
  normalizeDeployEnv,
  normalizeDeploySha,
  readDeployInfo,
} from './deploy';

describe('normalizeDeployEnv', () => {
  it('узнаёт стенды и приводит регистр с пробелами', () => {
    expect(normalizeDeployEnv('staging')).toBe('staging');
    expect(normalizeDeployEnv('  PREPROD ')).toBe('preprod');
  });

  it('прод, локальная разработка и мусор — плашки нет', () => {
    expect(normalizeDeployEnv(undefined)).toBeNull();
    expect(normalizeDeployEnv('')).toBeNull();
    expect(normalizeDeployEnv('production')).toBeNull();
    expect(normalizeDeployEnv('staging2')).toBeNull();
  });
});

describe('normalizeDeploySha', () => {
  it('сокращает полный sha и принимает уже короткий', () => {
    expect(normalizeDeploySha('b3c6c224475fa62432f2b27295b61cda187ea222')).toBe('b3c6c22');
    expect(normalizeDeploySha('B3C6C22')).toBe('b3c6c22');
  });

  it('не выдумывает sha из мусора и коротких значений', () => {
    expect(normalizeDeploySha(undefined)).toBeNull();
    expect(normalizeDeploySha('main')).toBeNull();
    expect(normalizeDeploySha('abc123')).toBeNull();
    expect(normalizeDeploySha('b3c6c22-грязно')).toBeNull();
  });
});

describe('normalizeDeployAt', () => {
  it('разбирает ISO-8601 из `.deployed-sha`', () => {
    expect(normalizeDeployAt('2026-11-16T11:09:05Z')?.toISOString()).toBe(
      '2026-11-16T11:09:05.000Z',
    );
  });

  it('пустое и неразбираемое значение — null, а не «1970»', () => {
    expect(normalizeDeployAt(undefined)).toBeNull();
    expect(normalizeDeployAt('')).toBeNull();
    expect(normalizeDeployAt('вчера')).toBeNull();
  });
});

describe('readDeployInfo', () => {
  it('на стенде собирает все три поля', () => {
    const info = readDeployInfo({
      DEPLOY_ENV: 'staging',
      DEPLOY_SHA: 'b3c6c224475fa62432f2b27295b61cda187ea222',
      DEPLOY_AT: '2026-11-16T11:09:05Z',
    });

    expect(info).toEqual({
      env: 'staging',
      sha: 'b3c6c22',
      at: new Date('2026-11-16T11:09:05Z'),
    });
  });

  it('без DEPLOY_ENV (прод, локальная разработка) — null, даже если sha задан', () => {
    expect(readDeployInfo({})).toBeNull();
    expect(readDeployInfo({ DEPLOY_ENV: '', DEPLOY_SHA: 'b3c6c22' })).toBeNull();
    expect(readDeployInfo({ DEPLOY_ENV: 'production', DEPLOY_SHA: 'b3c6c22' })).toBeNull();
  });

  it('неизвестные sha и время не ломают плашку: поля становятся null', () => {
    expect(
      readDeployInfo({ DEPLOY_ENV: 'preprod', DEPLOY_SHA: 'main', DEPLOY_AT: 'скоро' }),
    ).toEqual({
      env: 'preprod',
      sha: null,
      at: null,
    });
  });
});

describe('форматирование в часовом поясе салона', () => {
  it('часы показывают МСК, а не UTC', () => {
    expect(formatClock(new Date('2026-11-16T11:09:05Z'))).toBe('14:09:05');
  });

  it('время деплоя — дата и минуты в МСК', () => {
    expect(formatDeployMoment(new Date('2026-11-16T11:09:05Z'))).toBe('16.11, 14:09');
  });
});
