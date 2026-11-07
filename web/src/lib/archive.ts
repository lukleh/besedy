import { TimestampIdSchema } from '@/lib/validation/schemas';

export class ArchiveConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveConfigurationError';
  }
}

export class ArchiveScopeError extends Error {
  constructor() {
    super('Catalog not found');
    this.name = 'ArchiveScopeError';
  }
}

export interface ArchiveBinding {
  id: string;
  label: string | null;
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

/** Validate the configured record on every request; deactivation fails closed. */
export async function requireArchive(): Promise<ArchiveBinding> {
  const id = requireArchiveId();
  const { default: prisma } = await import('@/lib/db');
  const group = await prisma.workflowGroup.findUnique({
    where: { id },
    select: { id: true, label: true, isActive: true },
  });
  if (!group?.isActive) {
    throw new ArchiveConfigurationError(
      'BESEDY_ARCHIVE_ID must name an existing active source; run the archive preflight',
    );
  }
  return { id: group.id, label: group.label };
}

export async function assertArchiveCatalogId(catalogId: string): Promise<void> {
  const archive = await requireArchive();
  if (archive.id !== catalogId) throw new ArchiveScopeError();
}

/** Filesystem resolvers also refuse foreign IDs before constructing a path. */
export function assertConfiguredArchiveId(catalogId: string): void {
  if (requireArchiveId() !== catalogId) throw new ArchiveScopeError();
}
