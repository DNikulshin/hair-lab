-- Расширение для EXCLUDE-констрейнта: оператор равенства по uuid в GiST-индексе.
-- btree_gist — trusted-расширение, доступно владельцу БД (см. .env.example / docker-compose).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "schedule_exception_kind" AS ENUM ('vacation', 'sick', 'personal', 'other');

-- CreateEnum
CREATE TYPE "appointment_status" AS ENUM ('pending', 'confirmed', 'cancelled', 'completed', 'no_show');

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "duration_min" INTEGER NOT NULL,
    "price_kopecks" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "services_duration_min_check" CHECK ("duration_min" > 0),
    CONSTRAINT "services_price_kopecks_check" CHECK ("price_kopecks" >= 0)
);

-- CreateTable
CREATE TABLE "masters" (
    "id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "bio" TEXT,
    "photo_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "masters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_services" (
    "master_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,

    CONSTRAINT "master_services_pkey" PRIMARY KEY ("master_id","service_id")
);

-- CreateTable
CREATE TABLE "master_working_hours" (
    "id" UUID NOT NULL,
    "master_id" UUID NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,

    CONSTRAINT "master_working_hours_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "master_working_hours_day_of_week_check" CHECK ("day_of_week" BETWEEN 0 AND 6),
    CONSTRAINT "master_working_hours_start_minute_check" CHECK ("start_minute" BETWEEN 0 AND 1440),
    CONSTRAINT "master_working_hours_end_minute_check" CHECK ("end_minute" BETWEEN 0 AND 1440),
    CONSTRAINT "master_working_hours_interval_check" CHECK ("end_minute" > "start_minute")
);

-- CreateTable
CREATE TABLE "schedule_exceptions" (
    "id" UUID NOT NULL,
    "master_id" UUID NOT NULL,
    "kind" "schedule_exception_kind" NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "schedule_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "master_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "client_name" TEXT NOT NULL,
    "client_phone" TEXT NOT NULL,
    "client_email" TEXT,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "appointment_status" NOT NULL DEFAULT 'pending',
    "price_kopecks" INTEGER NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "idempotency_key" TEXT,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "appointments_interval_check" CHECK ("ends_at" > "starts_at"),
    CONSTRAINT "appointments_price_kopecks_check" CHECK ("price_kopecks" >= 0),
    CONSTRAINT "appointments_duration_min_check" CHECK ("duration_min" > 0)
);

-- CreateIndex
CREATE INDEX "master_services_service_id_idx" ON "master_services"("service_id");

-- CreateIndex
CREATE UNIQUE INDEX "master_working_hours_master_id_day_of_week_start_minute_key" ON "master_working_hours"("master_id", "day_of_week", "start_minute");

-- CreateIndex
CREATE INDEX "schedule_exceptions_master_id_starts_at_idx" ON "schedule_exceptions"("master_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_idempotency_key_key" ON "appointments"("idempotency_key");

-- CreateIndex
CREATE INDEX "appointments_master_id_starts_at_idx" ON "appointments"("master_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_service_id_idx" ON "appointments"("service_id");

-- AddForeignKey
ALTER TABLE "master_services" ADD CONSTRAINT "master_services_master_id_fkey" FOREIGN KEY ("master_id") REFERENCES "masters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_services" ADD CONSTRAINT "master_services_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_working_hours" ADD CONSTRAINT "master_working_hours_master_id_fkey" FOREIGN KEY ("master_id") REFERENCES "masters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_master_id_fkey" FOREIGN KEY ("master_id") REFERENCES "masters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_master_id_fkey" FOREIGN KEY ("master_id") REFERENCES "masters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Непересечение слотов одного мастера на уровне БД.
-- Длительность зависит от услуги, поэтому фиксированной сетки нет: EXCLUDE по диапазону
-- гарантирует уникальность при любой длительности. Отменённая запись слот не держит
-- (частичный констрейнт), а касание границ (end == start) допустимо: диапазон полуоткрытый.
ALTER TABLE "appointments"
    ADD CONSTRAINT "appointments_master_time_excl"
    EXCLUDE USING gist (
        "master_id" WITH =,
        tstzrange("starts_at", "ends_at", '[)') WITH &&
    )
    WHERE ("status" <> 'cancelled');
