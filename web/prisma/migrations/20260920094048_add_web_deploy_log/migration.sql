-- CreateTable
CREATE TABLE "web_deploy_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "git_commit" VARCHAR(40) NOT NULL,
    "web_version" VARCHAR(64) NOT NULL,
    "deployed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deployed_by" VARCHAR(120),
    "note" VARCHAR(500),

    CONSTRAINT "web_deploy_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "web_deploy_log_web_version_idx" ON "web_deploy_log"("web_version");

-- CreateIndex
CREATE INDEX "web_deploy_log_deployed_at_idx" ON "web_deploy_log"("deployed_at");
