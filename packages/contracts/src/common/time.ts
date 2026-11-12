import { z } from 'zod';

/** Момент времени в ISO 8601 с часовым поясом. В БД хранится в UTC. */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;

/** Идентификатор часового пояса IANA, например `Europe/Moscow`. */
export const timeZoneSchema = z.string().min(1).max(64);
export type TimeZone = z.infer<typeof timeZoneSchema>;
