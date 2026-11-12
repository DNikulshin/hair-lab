import { z } from 'zod';

export const defaultPageSize = 20;
export const maxPageSize = 100;

/** Курсорная пагинация: стабильна при вставках, в отличие от offset. */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(maxPageSize).default(defaultPageSize),
  cursor: z.string().min(1).max(200).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Обёртка для списков: `nextCursor = null` означает «дальше пусто». */
export function paginatedSchema<TItem extends z.ZodType>(itemSchema: TItem) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
  });
}
