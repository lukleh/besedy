-- CreateTable
CREATE TABLE "transcript_backend_priority" (
    "id" SERIAL NOT NULL,
    "backend" VARCHAR(255) NOT NULL,
    "priority" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transcript_backend_priority_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transcript_backend_priority_backend_key" ON "transcript_backend_priority"("backend");
