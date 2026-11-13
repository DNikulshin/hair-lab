import type {
  MastersResponse,
  Service as ServiceDto,
  ServicesQuery,
  ServicesResponse,
} from '@hair-lab/contracts';
import type { Db } from '../../shared/db';

/**
 * Чтение публичного каталога: услуги и мастера для витрины.
 *
 * Инвариант витрины: наружу не попадают неактивные услуги, неактивные категории
 * и неактивные мастера. Фильтр один и тот же и для списка услуг, и для услуг мастера.
 */

/** Структура строки услуги, достаточная для DTO (без служебных полей). */
interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
  durationMin: number;
  priceKopecks: number;
  category: { id: string; name: string } | null;
}

/**
 * Условие видимости услуги: услуга активна И (категории нет ИЛИ категория активна).
 * Через категорию неактивная категория скрывает и свои услуги.
 */
function visibleServiceWhere(categoryId?: string) {
  return {
    isActive: true,
    ...(categoryId === undefined ? {} : { categoryId }),
    OR: [{ categoryId: null }, { category: { isActive: true } }],
  };
}

/** Маппинг строки БД в DTO: копейки → money, nullable-поля → отсутствие в ответе. */
function toServiceDto(row: ServiceRow): ServiceDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    durationMin: row.durationMin,
    price: { amountMinor: row.priceKopecks, currency: 'RUB' },
    category: row.category === null ? null : { id: row.category.id, name: row.category.name },
  };
}

/** `GET /services`: только видимые услуги, порядок — sortOrder, затем имя. */
export async function listServices(db: Db, query: ServicesQuery): Promise<ServicesResponse> {
  const services = await db.service.findMany({
    where: visibleServiceWhere(query.categoryId),
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { category: true },
  });

  return { items: services.map((service) => toServiceDto(service)) };
}

/**
 * `GET /masters`: только активные мастера, услуги мастера подгружаются одним запросом
 * (include без N+1) и фильтруются по тому же правилу видимости.
 */
export async function listMasters(db: Db): Promise<MastersResponse> {
  const masters = await db.master.findMany({
    where: { isActive: true },
    orderBy: { fullName: 'asc' },
    include: {
      services: {
        where: { service: visibleServiceWhere() },
        orderBy: [{ service: { sortOrder: 'asc' } }, { service: { name: 'asc' } }],
        include: { service: { include: { category: true } } },
      },
    },
  });

  return {
    items: masters.map((master) => ({
      id: master.id,
      fullName: master.fullName,
      bio: master.bio ?? undefined,
      photoUrl: master.photoUrl ?? undefined,
      services: master.services.map((link) => toServiceDto(link.service)),
    })),
  };
}
