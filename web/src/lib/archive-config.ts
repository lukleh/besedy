import { TimestampIdSchema } from '@/lib/validation/schemas';

export class ArchiveConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveConfigurationError';
  }
}

export function requireArchiveId(
  raw = process.env.BESEDY_ARCHIVE_ID,
): string {
  if (raw === undefined || raw.trim() === '') {
    throw new ArchiveConfigurationError(
      'BESEDY_ARCHIVE_ID is required; choose a source after running the archive preflight',
    );
  }
  const parsed = TimestampIdSchema.safeParse(raw.trim());
  if (!parsed.success) {
    throw new ArchiveConfigurationError(
      'BESEDY_ARCHIVE_ID must be an explicit YYYYMMDD_HHMMSS source ID',
    );
  }
  return parsed.data;
}
