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

/** Unset is transitional only, until the single-archive client cutover. */
export function getConfiguredArchiveId(
  raw = process.env.BESEDY_ARCHIVE_ID,
): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = TimestampIdSchema.safeParse(raw.trim());
  if (!parsed.success) {
    throw new ArchiveConfigurationError(
      'BESEDY_ARCHIVE_ID must be an explicit YYYYMMDD_HHMMSS source ID',
    );
  }
  return parsed.data;
}

export function requireArchiveId(): string {
  const id = getConfiguredArchiveId();
  if (!id) {
    throw new ArchiveConfigurationError(
      'BESEDY_ARCHIVE_ID is required; choose a source after running the archive preflight',
    );
  }
  return id;
}

/** Validate the configured record on every request; deactivation fails closed. */
export async function getConfiguredArchive(): Promise<ArchiveBinding | null> {
  const id = getConfiguredArchiveId();
  if (!id) return null;
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

export async function requireArchive(): Promise<ArchiveBinding> {
  requireArchiveId();
  return (await getConfiguredArchive())!;
}

export async function assertArchiveCatalogId(catalogId: string): Promise<void> {
  const archive = await getConfiguredArchive();
  if (archive && archive.id !== catalogId) throw new ArchiveScopeError();
}

/** Filesystem resolvers also refuse foreign IDs before constructing a path. */
export function assertConfiguredArchiveId(catalogId: string): void {
  const id = getConfiguredArchiveId();
  if (id && id !== catalogId) throw new ArchiveScopeError();
}
