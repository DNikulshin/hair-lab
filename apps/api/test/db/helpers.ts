import { randomUUID } from 'node:crypto';
import { createSession } from '../../src/shared/auth/session';
import { createPrismaClient, type Db } from '../../src/shared/db';

/** SQLSTATE ошибки драйвера: тот же хелпер, что использует серверный код (маппинг 409). */
export { sqlStateOf } from '../../src/shared/db';

/**
 * Общие помощники интеграционных тестов БД.
 * Персональные данные вымышленные: ни телефоны, ни почты не существуют.
 */
export const fakeClient = {
  name: 'Тестовая Клиентка',
  phone: '+70000000000',
  email: 'guest@example.invalid',
} as const;

/** Клиент для тестовой БД. Без DATABASE_URL тесты не запускаются (нужен PostgreSQL). */
export function createTestDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL не задан: интеграционные тесты требуют PostgreSQL');
  }
  return createPrismaClient(url);
}

/**
 * Хелпер ожидания ошибки в тесте.
 * @returns ошибку как значение.
 */
export async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

interface Fixture {
  /** Создаёт мастера и возвращает его id. */
  master: (fullName?: string) => Promise<string>;
  /** Создаёт категорию услуг и возвращает её id. */
  category: (overrides?: {
    name?: string;
    isActive?: boolean;
    sortOrder?: number;
  }) => Promise<string>;
  /** Создаёт услугу и возвращает её id. */
  service: (overrides?: {
    name?: string;
    durationMin?: number;
    priceKopecks?: number;
    description?: string;
    categoryId?: string;
    isActive?: boolean;
    sortOrder?: number;
  }) => Promise<string>;
  /** Связывает мастера и услугу (m-n). */
  link: (masterId: string, serviceId: string) => Promise<void>;
  /**
   * Рабочие часы мастера: день недели (0 — воскресенье) и минуты от полуночи в TZ салона.
   * Удаляются каскадом вместе с мастером.
   */
  workingHours: (
    masterId: string,
    dayOfWeek: number,
    startMinute: number,
    endMinute: number,
  ) => Promise<void>;
  /** Исключение расписания (отпуск, больничный): абсолютный интервал UTC. */
  exception: (
    masterId: string,
    startsAt: string,
    endsAt: string,
    kind?: 'vacation' | 'sick' | 'personal' | 'other',
  ) => Promise<void>;
  /** Запись в расписании мастера, созданная в обход HTTP: проверка занятых слотов. */
  appointment: (
    masterId: string,
    serviceId: string,
    startsAt: string,
    endsAt: string,
    overrides?: { idempotencyKey?: string },
  ) => Promise<string>;
  /** Создаёт тестовый аккаунт (только example.invalid) и возвращает id. */
  client: (email?: string, passwordHash?: string) => Promise<string>;
  /** Создаёт сессию тестового клиента и возвращает токен для cookie. */
  session: (clientId: string) => Promise<string>;
  /** Помечает аккаунт, созданный HTTP-маршрутом, для точечной очистки. */
  trackClient: (clientId: string) => void;
  /** Удаляет только созданные в тесте строки (в порядке зависимостей). */
  cleanup: () => Promise<void>;
}

/**
 * Фабрика данных теста и точечная очистка: TRUNCATE всей базы не нужен,
 * удаляются только строки, созданные текущим тестом.
 */
export function createFixture(db: Db): Fixture {
  const masterIds: string[] = [];
  const serviceIds: string[] = [];
  const categoryIds: string[] = [];
  const clientIds: string[] = [];
  const sessionClientIds: string[] = [];

  return {
    async master(fullName = 'Тестовый Мастер') {
      const created = await db.master.create({ data: { fullName } });
      masterIds.push(created.id);
      return created.id;
    },

    async category(overrides = {}) {
      const created = await db.serviceCategory.create({
        data: { name: 'Тестовая категория', ...overrides },
      });
      categoryIds.push(created.id);
      return created.id;
    },

    async service(overrides = {}) {
      const created = await db.service.create({
        data: { name: 'Стрижка', durationMin: 60, priceKopecks: 350_000, ...overrides },
      });
      serviceIds.push(created.id);
      return created.id;
    },

    async link(masterId: string, serviceId: string) {
      await db.masterService.create({ data: { masterId, serviceId } });
    },

    async workingHours(
      masterId: string,
      dayOfWeek: number,
      startMinute: number,
      endMinute: number,
    ) {
      await db.masterWorkingHours.create({
        data: { masterId, dayOfWeek, startMinute, endMinute },
      });
    },

    async exception(
      masterId: string,
      startsAt: string,
      endsAt: string,
      kind: 'vacation' | 'sick' | 'personal' | 'other' = 'vacation',
    ) {
      await db.scheduleException.create({
        data: { masterId, startsAt: new Date(startsAt), endsAt: new Date(endsAt), kind },
      });
    },

    async client(email = `client-${randomUUID()}@example.invalid`, passwordHash?: string) {
      const created = await db.client.create({
        data: { email, ...(passwordHash === undefined ? {} : { passwordHash }) },
      });
      clientIds.push(created.id);
      return created.id;
    },

    async session(clientId: string) {
      sessionClientIds.push(clientId);
      return (await createSession(db, clientId)).token;
    },

    trackClient(clientId: string) {
      if (!clientIds.includes(clientId)) clientIds.push(clientId);
    },

    async appointment(
      masterId: string,
      serviceId: string,
      startsAt: string,
      endsAt: string,
      overrides: { idempotencyKey?: string } = {},
    ) {
      const created = await db.appointment.create({
        data: appointmentData(masterId, serviceId, startsAt, endsAt, overrides),
      });
      return created.id;
    },

    async cleanup() {
      const allSessionClientIds = [...new Set([...sessionClientIds, ...clientIds])];
      if (allSessionClientIds.length > 0) {
        await db.session.deleteMany({ where: { clientId: { in: allSessionClientIds } } });
      }
      if (clientIds.length > 0) await db.client.deleteMany({ where: { id: { in: clientIds } } });
      await db.appointment.deleteMany({
        where: { OR: [{ masterId: { in: masterIds } }, { serviceId: { in: serviceIds } }] },
      });
      // Рабочие часы, исключения и связи m-n удаляются каскадом.
      await db.master.deleteMany({ where: { id: { in: masterIds } } });
      // Услуги удаляются до категорий: на категории ссылается services.category_id.
      await db.service.deleteMany({ where: { id: { in: serviceIds } } });
      await db.serviceCategory.deleteMany({ where: { id: { in: categoryIds } } });
      masterIds.length = 0;
      serviceIds.length = 0;
      categoryIds.length = 0;
      clientIds.length = 0;
      sessionClientIds.length = 0;
    },
  };
}

/** Данные записи: снимки цены и длительности совпадают с услугой по умолчанию. */
export function appointmentData(
  masterId: string,
  serviceId: string,
  startsAt: string,
  endsAt: string,
  overrides: { idempotencyKey?: string; status?: 'pending' | 'confirmed' } = {},
) {
  return {
    masterId,
    serviceId,
    clientName: fakeClient.name,
    clientPhone: fakeClient.phone,
    clientEmail: fakeClient.email,
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    priceKopecks: 350_000,
    durationMin: 60,
    ...overrides,
  };
}
