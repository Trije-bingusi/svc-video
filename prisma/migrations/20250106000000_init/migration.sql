-- CreateEnum
DO $$ BEGIN
 CREATE TYPE "EncodingStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "VideoUpload" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lecture_id" UUID NOT NULL,
    "user_id" UUID,
    "filename" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL,
    "blob_url" TEXT NOT NULL,
    "blob_container" TEXT NOT NULL,
    "blob_name" TEXT NOT NULL,
    "ams_asset_name" TEXT,
    "ams_job_name" TEXT,
    "encoding_status" TEXT DEFAULT 'pending',
    "hls_url" TEXT,
    "duration" INTEGER,
    "resolution" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VideoUpload_lecture_id_idx" ON "VideoUpload"("lecture_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VideoUpload_user_id_idx" ON "VideoUpload"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VideoUpload_encoding_status_idx" ON "VideoUpload"("encoding_status");
