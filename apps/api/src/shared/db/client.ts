import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * Клиент Prisma с драйвер-адаптером `pg` (Prisma 7 работает без Rust-движка).
 * Модуль только для серверного кода: сгенерированный клиент не попадает в браузер.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export type Db = PrismaClient;
