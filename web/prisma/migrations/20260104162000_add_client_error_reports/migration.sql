-- CreateTable
CREATE TABLE "client_error_report" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "digest" VARCHAR(64),
    "source" VARCHAR(50),
    "url" TEXT,
    "user_agent" TEXT,
    "ip_address" VARCHAR(45),
    "context" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_error_report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_error_report_user_id_idx" ON "client_error_report"("user_id");

-- CreateIndex
CREATE INDEX "client_error_report_source_idx" ON "client_error_report"("source");

-- CreateIndex
CREATE INDEX "client_error_report_digest_idx" ON "client_error_report"("digest");

-- CreateIndex
CREATE INDEX "client_error_report_created_at_idx" ON "client_error_report"("created_at");

-- AddForeignKey
ALTER TABLE "client_error_report" ADD CONSTRAINT "client_error_report_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
