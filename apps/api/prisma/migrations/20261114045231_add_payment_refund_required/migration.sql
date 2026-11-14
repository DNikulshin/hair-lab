-- AlterTable
-- «Деньги получены, запись подтвердить нельзя, возврат обязателен». Флаг, а не разовый вызов
-- из обработчика уведомления: API ЮKassa может быть недоступен, а обязанность вернуть деньги
-- терять нельзя — её добивает свипер, ключ идемпотентности возврата стабилен.
-- Expand-совместимо: колонка NOT NULL с DEFAULT, старые читатели её не видят.
ALTER TABLE "payments" ADD COLUMN     "refund_required" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
-- Выборка свипера (`refund_required = true` каждые 30 с): строк с `true` единицы, индекс даёт
-- точечный доступ вместо последовательного чтения таблицы платежей.
CREATE INDEX "payments_refund_required_idx" ON "payments"("refund_required");
