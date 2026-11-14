-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('pending', 'succeeded', 'canceled', 'refunded');

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "payment_deadline_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'pending',
    "amount_kopecks" INTEGER NOT NULL,
    "yookassa_payment_id" TEXT,
    "confirmation_url" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_yookassa_payment_id_key" ON "payments"("yookassa_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_appointment_id_key" ON "payments"("appointment_id");

-- CreateIndex
CREATE INDEX "appointments_status_payment_deadline_at_idx" ON "appointments"("status", "payment_deadline_at");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma не выражает CHECK: сумма платежа строго положительна. Ноль и отрицательная сумма —
-- дефект кода (снимок цены услуги), а не допустимое состояние денег. В БД, а не только в коде:
-- ошибочный UPDATE не должен создать платёж, который провайдер примет за 0 ₽.
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_kopecks_check" CHECK ("amount_kopecks" > 0);
