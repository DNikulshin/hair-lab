-- Нормализация данных отмены (#253). Схема не меняется: правятся только строки, поэтому
-- миграция состоит из двух идемпотентных UPDATE (повторный запуск меняет 0 строк).
--
-- 1) Голое `cancelled_by_salon` без причины приводится к конвенции `cancelled_by_salon: <причина>`:
--    по префиксу видно, кто отменил, а сотрудник в админке видит причину текстом.
--    Код при этом терпим и к старой форме (`isSalonCancellation`), иначе повторная отмена
--    такой записи давала бы 409.
-- 2) У отменённых записей снимается дедлайн холда: отменённая запись оплаты не ждёт.
--    Все пути отмены (клиент, салон, свипер холдов) и платежи пишут NULL сами; здесь —
--    строки, отменённые до этой правки.
--
-- Чужие причины (`cancelled_by_client`, `payment_creation_failed`, `payment_canceled`,
-- `payment_expired`) не трогаются: условие — точное равенство. Откат данных не нужен:
-- нормализация не теряет информацию, а пустой дедлайн у отменённой записи был ошибкой.

-- NormalizeCancelReason
UPDATE "appointments"
SET "cancel_reason" = 'cancelled_by_salon: причина не указана'
WHERE "cancel_reason" = 'cancelled_by_salon';

-- ClearPaymentDeadlineForCancelled
UPDATE "appointments"
SET "payment_deadline_at" = NULL
WHERE "status" = 'cancelled'
  AND "payment_deadline_at" IS NOT NULL;
