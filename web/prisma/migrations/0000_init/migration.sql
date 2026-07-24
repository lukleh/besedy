-- Besedy Web Initial Schema
-- This migration creates the complete database schema.
-- Generated from schema.prisma on 2025-12-31

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "AccessLevel" AS ENUM ('VIEWER', 'MEMBER', 'EDITOR', 'OWNER');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'USER_ADDED', 'USER_ACTIVATED', 'USER_BLOCKED', 'USER_UNBLOCKED', 'ADMIN_ROLE_GRANTED', 'ADMIN_ROLE_REVOKED', 'ADMIN_ROLE_UPDATED', 'CATALOG_ACCESS_GRANTED', 'CATALOG_ACCESS_UPDATED', 'CATALOG_ACCESS_REVOKED', 'CATALOG_VIEWED', 'AUDIO_STREAMED', 'AUDIO_DOWNLOADED', 'TRANSCRIPT_VIEWED', 'TRANSCRIPT_DOWNLOADED', 'METADATA_UPDATED', 'METADATA_VERIFIED', 'ACCESS_DENIED', 'SUPERADMIN_ACCESS');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "is_superadmin" BOOLEAN NOT NULL DEFAULT false,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "invited_by_id" TEXT,
    "invited_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_access" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "catalog_id" VARCHAR(15) NOT NULL,
    "access_level" "AccessLevel" NOT NULL DEFAULT 'VIEWER',
    "granted_by_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_group" (
    "id" VARCHAR(15) NOT NULL,
    "label" TEXT,
    "archived_catalog_path" TEXT NOT NULL,
    "metadata_catalog_path" TEXT NOT NULL,
    "duplicates_catalog_path" TEXT,
    "transcripts_path" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_variant" (
    "id" SERIAL NOT NULL,
    "workflow_group_id" VARCHAR(15) NOT NULL,
    "variant" VARCHAR(50) NOT NULL,
    "label" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "listening_archived_catalog_path" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audio_metadata" (
    "id" SERIAL NOT NULL,
    "workflow_group_id" VARCHAR(15) NOT NULL,
    "audio_hash" VARCHAR(64) NOT NULL,
    "title" TEXT,
    "artist" TEXT,
    "album" TEXT,
    "date_year" INTEGER,
    "date_month" INTEGER,
    "date_day" INTEGER,
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(3),
    "verified_by" VARCHAR(255),
    "recorder_id" INTEGER,
    "location_id" INTEGER,
    "part" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audio_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "user_id" VARCHAR(255) NOT NULL,
    "active_group" VARCHAR(15),
    "theme" VARCHAR(10) NOT NULL DEFAULT 'system',
    "catalog_columns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "settings" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" "AuditAction" NOT NULL,
    "resource" VARCHAR(50) NOT NULL,
    "resource_id" VARCHAR(64),
    "details" JSONB,
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recorders" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recorders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_id_account_id_key" ON "accounts"("provider_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE INDEX "catalog_access_catalog_id_idx" ON "catalog_access"("catalog_id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_access_user_id_catalog_id_key" ON "catalog_access"("user_id", "catalog_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_variant_workflow_group_id_variant_key" ON "workflow_variant"("workflow_group_id", "variant");

-- CreateIndex
CREATE INDEX "audio_metadata_recorder_id_idx" ON "audio_metadata"("recorder_id");

-- CreateIndex
CREATE INDEX "audio_metadata_location_id_idx" ON "audio_metadata"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "audio_metadata_workflow_group_id_audio_hash_key" ON "audio_metadata"("workflow_group_id", "audio_hash");

-- CreateIndex
CREATE INDEX "audit_log_user_id_idx" ON "audit_log"("user_id");

-- CreateIndex
CREATE INDEX "audit_log_action_idx" ON "audit_log"("action");

-- CreateIndex
CREATE INDEX "audit_log_resource_resource_id_idx" ON "audit_log"("resource", "resource_id");

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "recorders_name_key" ON "recorders"("name");

-- CreateIndex
CREATE UNIQUE INDEX "locations_name_key" ON "locations"("name");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_access" ADD CONSTRAINT "catalog_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_access" ADD CONSTRAINT "catalog_access_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_access" ADD CONSTRAINT "catalog_access_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_variant" ADD CONSTRAINT "workflow_variant_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_metadata" ADD CONSTRAINT "audio_metadata_workflow_group_id_fkey" FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_metadata" ADD CONSTRAINT "audio_metadata_recorder_id_fkey" FOREIGN KEY ("recorder_id") REFERENCES "recorders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_metadata" ADD CONSTRAINT "audio_metadata_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_active_group_fkey" FOREIGN KEY ("active_group") REFERENCES "workflow_group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
