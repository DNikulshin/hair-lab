import { z } from 'zod';

/** Идентификатор сущности во всех публичных контрактах. */
export const idSchema = z.uuid();
export type Id = z.infer<typeof idSchema>;

/** Идентификатор, который создаёт клиент (идемпотентность записи на услугу). */
export const idempotencyKeySchema = z.string().min(8).max(128);
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;
