-- AlterEnum
ALTER TYPE "RecordingIntakeStatus" ADD VALUE 'REMOVING';
ALTER TYPE "RecordingIntakeStatus" ADD VALUE 'REMOVED';

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'RECORDING_INGEST_REMOVED';
