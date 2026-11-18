-- Expand: факт и статус последней попытки возврата живут в БД, а не только в логе.
-- `refund_id` — id возврата в ЮKassa (пишется, если провайдер его вернул), `refund_status` —
-- его статус. NULL означает «попыток не было», `unknown` — «попытка была, ответ не распознан».
-- Колонки nullable и без DEFAULT: бэкфилл не нужен (возвраты до этой миграции уже `refunded`,
-- а их id нигде не сохранялся), старые читатели новые колонки просто не видят.
-- Откат (expand, отдельной миграцией при необходимости):
--   ALTER TABLE "payments" DROP COLUMN "refund_id", DROP COLUMN "refund_status";
--   DROP TYPE "refund_status";
-- Откат теряет накопленные данные о возвратах: старый код их не читал, поэтому поведение
-- не меняется, но история попыток пропадёт.

-- CreateEnum
CREATE TYPE "refund_status" AS ENUM ('succeeded', 'pending', 'canceled', 'unknown');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "refund_id" TEXT,
ADD COLUMN     "refund_status" "refund_status";
