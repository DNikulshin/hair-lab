-- CreateTable
CREATE TABLE "login_tokens" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "client_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "login_tokens_token_hash_key" ON "login_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "login_tokens_client_id_consumed_at_idx" ON "login_tokens"("client_id", "consumed_at");

-- AddForeignKey
ALTER TABLE "login_tokens" ADD CONSTRAINT "login_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
