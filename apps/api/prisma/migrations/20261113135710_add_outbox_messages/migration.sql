-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('pending', 'sent', 'failed', 'suppressed');

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "appointment_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_messages_status_next_attempt_at_idx" ON "outbox_messages"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "outbox_messages_sent_at_idx" ON "outbox_messages"("sent_at");

-- AddForeignKey
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
