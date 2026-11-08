import prisma from '@/lib/db';
import { requireArchiveId } from '@/lib/archive';

interface GrantInventory {
  catalogId: string;
  role: string;
  extraPermissions: string[];
  status: string;
}

/** Multiple source grants require review even when their permissions match. */
export function findArchiveGrantConflicts<T extends GrantInventory>(
  grants: T[],
  subjectOf: (grant: T) => string,
) {
  const subjects = new Map<string, T[]>();
  for (const grant of grants) {
    const subject = subjectOf(grant);
    const rows = subjects.get(subject) ?? [];
    rows.push(grant);
    subjects.set(subject, rows);
  }
  return Array.from(subjects.entries())
    .filter(([, rows]) => new Set(rows.map((row) => row.catalogId)).size > 1)
    .map(([subject, rows]) => ({
      subject,
      grants: rows,
      permissionsDiffer: new Set(rows.map((row) => JSON.stringify({
        role: row.role,
        extras: [...row.extraPermissions].sort(),
        status: row.status,
      }))).size > 1,
    }));
}

/** Database inventory only: no source reads, projection sync or grant writes. */
export async function inspectArchiveMigration() {
  const archiveId = requireArchiveId();
  return prisma.$transaction(async (tx) => {
    // Enforce the read-only promise in PostgreSQL as well as in this code.
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const groups = await tx.workflowGroup.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true, label: true, isActive: true, isDefault: true,
        archivedCatalogPath: true, metadataCatalogPath: true,
        duplicatesCatalogPath: true, transcriptsPath: true,
        _count: true,
      },
    });
    const grants = await tx.catalogAccess.findMany({
      orderBy: [{ userId: 'asc' }, { catalogId: 'asc' }],
      select: { userId: true, catalogId: true, role: true, extraPermissions: true, status: true },
    });
    const pendingGrants = await tx.pendingCatalogGrant.findMany({
      orderBy: [{ email: 'asc' }, { catalogId: 'asc' }],
      select: { email: true, catalogId: true, role: true, extraPermissions: true, status: true },
    });
    const admissions = await tx.portalAdmission.findMany({
      where: { status: 'PENDING' },
      orderBy: { email: 'asc' },
      select: { email: true, source: true },
    });
    const users = await tx.user.findMany({
      where: { status: 'ACTIVE', isAdmin: false, isSuperadmin: false },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    const activeIntakes = await tx.recordingIntake.findMany({
      where: { status: { in: ['UPLOADING', 'QUEUED', 'RUNNING', 'REMOVING'] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, workflowGroupId: true, status: true, jobId: true },
    });
    const publications = await tx.transcriptPublication.groupBy({
      by: ['workflowGroupId', 'status'],
      _count: { _all: true },
    });
    const publicationOperations = await tx.transcriptPublication.findMany({
      where: { status: { in: ['PENDING', 'ACTIVATING', 'ROLLING_BACK'] } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, workflowGroupId: true, audioHash: true, status: true,
        indexJobId: true, indexRequestedAt: true,
      },
    });
    const searchWithdrawals = await tx.transcriptWorkspace.findMany({
      where: { searchWithdrawalId: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, workflowGroupId: true, audioHash: true,
        searchWithdrawalId: true, searchWithdrawalJobId: true,
      },
    });
    const archive = groups.find((group) => group.id === archiveId);
    const boundPendingEmails = new Set(pendingGrants
      .filter((grant) => grant.catalogId === archiveId && grant.status === 'PENDING')
      .map((grant) => grant.email));
    const standaloneInvitations = admissions.filter((row) => !boundPendingEmails.has(row.email));
    const boundUsers = new Set(grants
      .filter((grant) => grant.catalogId === archiveId && grant.status === 'ACTIVE')
      .map((grant) => grant.userId));
    const usersWithoutArchiveAccess = users.filter((user) => !boundUsers.has(user.id));
    const membershipConflicts = findArchiveGrantConflicts(grants, (grant) => grant.userId);
    const invitationConflicts = findArchiveGrantConflicts(pendingGrants, (grant) => grant.email);
    const otherSourcesWithData = groups.filter((group) => group.id !== archiveId
      && Object.values(group._count).some((count) => count > 0));
    const blockers: string[] = [];
    if (!archive?.isActive) blockers.push('Selected source is missing or inactive');
    if (otherSourcesWithData.length) blockers.push('Other sources have retained references; review their disposition');
    if (membershipConflicts.length) blockers.push('Memberships span sources; select grants without union or promotion');
    if (invitationConflicts.length || standaloneInvitations.length) blockers.push('Pending invitations need an explicit permission mapping or cancellation');
    if (usersWithoutArchiveAccess.length) blockers.push('Existing non-admin users lack active access to the selected archive');
    if (activeIntakes.length) blockers.push('Finish or explicitly resolve in-flight uploads/jobs before cutover');
    if (publicationOperations.length || searchWithdrawals.length) blockers.push('Finish or explicitly resolve publication and withdrawal indexing before cutover');
    return {
      archiveId, blockers, groups, publications,
      grants, pendingGrants, membershipConflicts, invitationConflicts,
      standaloneInvitations, usersWithoutArchiveAccess, activeIntakes,
      publicationOperations, searchWithdrawals,
    };
  }, { isolationLevel: 'RepeatableRead' });
}
