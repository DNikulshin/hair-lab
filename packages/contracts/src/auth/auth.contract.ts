import { z } from 'zod';
import { idSchema } from '../common/ids';
import { isoDateTimeSchema } from '../common/time';

/**
 * Аккаунт клиента: регистрация и вход по email и паролю (`/auth/register`, `/auth/login`),
 * текущий клиент (`GET /auth/me`), выход (`POST /auth/logout`).
 *
 * Инварианты, которые обеспечивает API (в схеме не выражаются):
 * - вход выдаёт непрозрачную сессию в httpOnly cookie; токена в теле ответа нет,
 *   поэтому клиент (web, будущий mobile) cookie не разбирает и не хранит;
 * - неверный пароль и неизвестный email дают одинаковый 401 `unauthorized`
 *   (по ответу нельзя узнать, зарегистрирован ли адрес);
 * - повторная регистрация занятого адреса — 409 `conflict`;
 * - почта и пароль в ответы и логи не попадают: `authResponseSchema` содержит только
 *   идентификатор, нормализованный email и отметку подтверждения.
 *
 * Почта нормализуется на границе (`trim` + нижний регистр): вход и регистрация сравнивают
 * адреса по каноническому виду, а не по тому, как их набрали. Пароль не нормализуется
 * (пробелы — значимые символы), ограничения только по длине: короткий пароль легко
 * подобрать, очень длинный — способ нагрузить сервер хешированием.
 */

/** Предел длины адреса почты по RFC 5321 (путь в обратном направлении). */
export const EMAIL_MAX_LENGTH = 254;

/** Минимальная длина пароля: ниже — слишком легко подобрать. */
export const PASSWORD_MIN_LENGTH = 10;

/** Максимальная длина пароля: ограничение стоимости argon2 на один запрос. */
export const PASSWORD_MAX_LENGTH = 128;

/** Адрес почты клиента: `trim`, нижний регистр, валидный email не длиннее 254 символов. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .email('Проверьте адрес почты')
      .max(EMAIL_MAX_LENGTH, 'Адрес почты слишком длинный: не больше 254 символов'),
  );
export type Email = z.infer<typeof emailSchema>;

/** Пароль: 10–128 символов, без нормализации (`trim` не применяется). */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, 'Пароль короче 10 символов')
  .max(PASSWORD_MAX_LENGTH, 'Пароль длиннее 128 символов');
export type Password = z.infer<typeof passwordSchema>;

/** Тело `POST /auth/register`: почта и пароль нового аккаунта. */
export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/** Тело `POST /auth/login`. */
export const loginRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Аккаунт клиента в ответах API. `emailVerifiedAt` — момент подтверждения почты;
 * `null` означает «ещё не подтверждён». Телефон, имя и история визитов в этот DTO не входят.
 */
export const clientAccountSchema = z.object({
  id: idSchema,
  email: emailSchema,
  emailVerifiedAt: isoDateTimeSchema.nullable(),
});
export type ClientAccount = z.infer<typeof clientAccountSchema>;

/** Ответ `POST /auth/register`, `POST /auth/login`, `GET /auth/me`. */
export const authResponseSchema = z.object({
  client: clientAccountSchema,
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

/** Ответ `POST /auth/logout`: действие идемпотентно, поэтому клиенту достаточно `ok`. */
export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;
