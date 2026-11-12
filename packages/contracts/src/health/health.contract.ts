import { z } from 'zod';

export const healthStatusSchema = z.enum(['ok', 'degraded']);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

/** Ответ `GET /health`: по этой схеме проверяется работоспособность API. */
export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  version: z.string().min(1),
  checkedAt: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
