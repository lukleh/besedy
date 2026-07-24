-- CreateTable
CREATE TABLE "deep_search_job_shares" (
    "id" TEXT NOT NULL,
    "job_id" UUID NOT NULL,
    "catalog_id" VARCHAR(15) NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "shared_with_user_id" TEXT NOT NULL,
    "shared_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deep_search_job_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deep_search_job_shares_job_id_shared_with_user_id_key" ON "deep_search_job_shares"("job_id", "shared_with_user_id");

-- CreateIndex
CREATE INDEX "deep_search_job_shares_catalog_id_shared_with_user_id_idx" ON "deep_search_job_shares"("catalog_id", "shared_with_user_id");

-- CreateIndex
CREATE INDEX "deep_search_job_shares_owner_user_id_idx" ON "deep_search_job_shares"("owner_user_id");

-- CreateIndex
CREATE INDEX "deep_search_job_shares_shared_by_user_id_idx" ON "deep_search_job_shares"("shared_by_user_id");

-- AddForeignKey
ALTER TABLE "deep_search_job_shares" ADD CONSTRAINT "deep_search_job_shares_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deep_search_job_shares" ADD CONSTRAINT "deep_search_job_shares_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deep_search_job_shares" ADD CONSTRAINT "deep_search_job_shares_shared_with_user_id_fkey" FOREIGN KEY ("shared_with_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deep_search_job_shares" ADD CONSTRAINT "deep_search_job_shares_shared_by_user_id_fkey" FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
