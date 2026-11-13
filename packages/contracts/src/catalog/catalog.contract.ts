import { z } from 'zod';
import { idSchema } from '../common/ids';
import { moneySchema } from '../common/money';

/**
 * Публичный каталог салона: услуги, категории услуг и мастера.
 *
 * Инварианты ответов (не выражаются в схеме, обеспечиваются API):
 * - отдаются только активные услуги, активные категории и активные мастера;
 * - `isActive` и таймстемпы в DTO не попадают: ответ детерминирован и пригоден для кэша.
 */
export const serviceCategorySchema = z.object({
  id: idSchema,
  name: z.string().min(1),
});
export type ServiceCategory = z.infer<typeof serviceCategorySchema>;

/** Услуга каталога: цена в копейках, длительность в минутах. */
export const serviceSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  durationMin: z.number().int().positive(),
  price: moneySchema,
  category: serviceCategorySchema.nullable(),
});
export type Service = z.infer<typeof serviceSchema>;

/** Мастер публичного каталога и услуги, которые он оказывает. */
export const masterSchema = z.object({
  id: idSchema,
  fullName: z.string().min(1),
  bio: z.string().optional(),
  photoUrl: z.string().min(1).optional(),
  services: z.array(serviceSchema),
});
export type Master = z.infer<typeof masterSchema>;

/** Параметры `GET /services`: фильтр по категории. */
export const servicesQuerySchema = z.object({
  categoryId: idSchema.optional(),
});
export type ServicesQuery = z.infer<typeof servicesQuerySchema>;

/**
 * Ответы каталога — массив в обёртке `{items}` без курсора:
 * каталог одного салона заведомо небольшой, `nextCursor` добавляется аддитивно при росте.
 */
export const servicesResponseSchema = z.object({
  items: z.array(serviceSchema),
});
export type ServicesResponse = z.infer<typeof servicesResponseSchema>;

export const mastersResponseSchema = z.object({
  items: z.array(masterSchema),
});
export type MastersResponse = z.infer<typeof mastersResponseSchema>;
