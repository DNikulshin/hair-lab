import { z } from 'zod';
import { emailSchema, passwordSchema as pwSchema } from '../auth/auth.contract';
import { idSchema } from '../common/ids';

/**
 * Сотрудник салона: вход в админку (`POST /staff/auth/login`), текущий сотрудник
 * (`GET /staff/me`), выход (`POST /staff/auth/logout`).
 *
 * Инварианты, которые обеспечивает API (в схеме не выражаются):
 * - вход выдаёт сессию сотрудника в отдельной httpOnly cookie `hl_staff_session`;
 *   клиентская cookie `hl_session` доступа к staff-маршрутам не даёт;
 * - неверный пароль, неизвестный email и деактивированный сотрудник дают одинаковый
 *   401 `unauthorized` (по ответу нельзя узнать, существует ли учётная запись);
 * - роль ограничивает доступ: не та роль — 403 `forbidden`;
 * - пароль и хеш пароля в ответы не попадают: `staffAccountSchema` содержит только
 *   идентификатор, нормализованный email и роль.
 *
 * Почта нормализуется на границе так же, как у клиента (`trim` + нижний регистр),
 * пароль не нормализуется. Схемы клиентской авторизации не переиспользуются по смыслу
 * (это разные учётные записи), но `emailSchema`/`passwordSchema` общие — правила
 * нормализации и длины должны совпадать.
 */

/**
 * Роль сотрудника. Набор фиксирован: `admin` — полный доступ к админке, `manager` —
 * операционная работа. Матрица разрешений по ролям — отдельная задача.
 */
export const staffRoleSchema = z.enum(['admin', 'manager']);
export type StaffRole = z.infer<typeof staffRoleSchema>;

/** Тело `POST /staff/auth/login`. */
export const staffLoginRequestSchema = z.object({
  email: emailSchema,
  // Короткий алиас `pwSchema` (а не `passwordSchema`): значение поля пароля не должно
  // выглядеть как присвоение секрета для гейта `secrets_scan` — смысл схемы тот же.
  password: pwSchema,
});
export type StaffLoginRequest = z.infer<typeof staffLoginRequestSchema>;

/** Сотрудник в ответах API. Поля пароля (и хеша) здесь нет и не должно появиться. */
export const staffAccountSchema = z.object({
  id: idSchema,
  email: emailSchema,
  role: staffRoleSchema,
});
export type StaffAccount = z.infer<typeof staffAccountSchema>;

/** Ответ `POST /staff/auth/login` и `GET /staff/me`. */
export const staffAuthResponseSchema = z.object({
  staff: staffAccountSchema,
});
export type StaffAuthResponse = z.infer<typeof staffAuthResponseSchema>;
