import { z } from 'zod';

/** Валюта расчётов. Салон один, поэтому пока одна валюта. */
export const currencySchema = z.literal('RUB');
export type Currency = z.infer<typeof currencySchema>;

/**
 * Деньги передаются в минимальных единицах (копейки), чтобы избежать
 * ошибок округления с плавающей точкой.
 */
export const moneySchema = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: currencySchema,
});
export type Money = z.infer<typeof moneySchema>;
