import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requireArchive } from '@/lib/archive';
import {
  countPendingPortalAdmissions,
  listPendingAdminAdmissions,
  type PendingAdmissionRecord,
  type PendingInvitationGrant,
} from '@/lib/admission/admin-read-models';
import { loadPendingAdmissionState } from '@/lib/admission/admin-pending-record-shared';

const sharedDb = vi.hoisted(() => ({
  portalAdmission: { findFirst: vi.fn() },
  pendingCatalogGrant: { findUnique: vi.fn() },
  user: { findMany: vi.fn() },
}));

vi.mock('@/lib/db', () => ({ default: sharedDb }));
vi.mock('@/lib/archive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/archive')>()),
  requireArchive: vi.fn(),
}));

const ARCHIVE = { id: '20260101_000000', label: 'Catalog One' };
const ADMITTED_AT = new Date('2026-03-10T10:00:00.000Z');
const GRANTED_AT = new Date('2026-03-10T11:00:00.000Z');
type StoredGrant = PendingInvitationGrant & {
  email: string;
  status: 'PENDING' | 'CONSUMED' | 'REVOKED';
};
type Actor = { id: string; name: string | null; email: string | null };

function makeAdmission(
  overrides: Partial<PendingAdmissionRecord> = {},
): PendingAdmissionRecord {
  return {
    email: 'pending@example.com',
    admittedAt: ADMITTED_AT,
    admittedById: null,
    notes: null,
    ...overrides,
  };
}

function makeGrant(overrides: Partial<StoredGrant> = {}): StoredGrant {
  return {
    email: 'pending@example.com',
    catalogId: ARCHIVE.id,
    status: 'PENDING',
    role: 'reader',
    extraPermissions: [],
    notes: null,
    grantedAt: GRANTED_AT,
    grantedById: null,
    ...overrides,
  };
}

function listDb(
  admissions: PendingAdmissionRecord[],
  grants: StoredGrant[] = [],
  actors: Actor[] = [],
) {
  return {
    portalAdmission: { findMany: vi.fn().mockResolvedValue(admissions) },
    pendingCatalogGrant: {
      findMany: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          grants.filter(
            (grant) =>
              grant.catalogId === where.catalogId &&
              grant.status === where.status &&
              where.email.in.includes(grant.email),
          ),
        ),
    },
    user: {
      findMany: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          actors.filter((actor) => where.id.in.includes(actor.id)),
        ),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireArchive).mockResolvedValue(ARCHIVE);
});

describe('admission admin read models', () => {
  it('presents one archive invitation with its role, extras and fallback inviter', async () => {
    const inviter = {
      id: 'owner-1',
      name: 'Owner User',
      email: 'owner@example.com',
    };
    const db = listDb(
      [makeAdmission({ admittedById: 'deleted-admin' })],
      [
        makeGrant({
          role: 'curator',
          extraPermissions: ['download_audio'],
          notes: 'catalog note',
          grantedById: inviter.id,
        }),
      ],
      [inviter],
    );

    const result = await listPendingAdminAdmissions('pending', db as never);

    expect(db.portalAdmission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'PENDING',
          email: { contains: 'pending', mode: 'insensitive' },
        },
        orderBy: { admittedAt: 'desc' },
      }),
    );
    expect(result).toEqual([
      {
        id: 'pending@example.com',
        email: 'pending@example.com',
        status: 'PENDING',
        invitedAt: ADMITTED_AT.toISOString(),
        catalogId: ARCHIVE.id,
        catalogLabel: ARCHIVE.label,
        role: 'curator',
        extraPermissions: ['download_audio'],
        invitedBy: inviter,
        notes: 'catalog note',
      },
    ]);
  });

  it('uses the bound archive id when its label is blank', async () => {
    vi.mocked(requireArchive).mockResolvedValue({ ...ARCHIVE, label: '' });
    const db = listDb([makeAdmission()], [makeGrant()]);

    expect(await listPendingAdminAdmissions(undefined, db as never)).toEqual([
      expect.objectContaining({
        catalogId: ARCHIVE.id,
        catalogLabel: ARCHIVE.id,
        role: 'reader',
      }),
    ]);
  });

  it('retains orphan admissions without implying any content access', async () => {
    const db = listDb([
      makeAdmission({
        email: 'nogrant@example.com',
        admittedById: 'missing-admin',
        notes: 'admission only',
      }),
    ]);

    expect(await listPendingAdminAdmissions(undefined, db as never)).toEqual([
      {
        id: 'nogrant@example.com',
        email: 'nogrant@example.com',
        status: 'PENDING',
        invitedAt: ADMITTED_AT.toISOString(),
        catalogId: null,
        catalogLabel: null,
        role: null,
        extraPermissions: [],
        invitedBy: null,
        notes: 'admission only',
      },
    ]);
  });

  it('preserves admission attribution when the grant has another inviter', async () => {
    const admittedBy = {
      id: 'admin-1',
      name: 'Admin',
      email: 'admin@example.com',
    };
    const grantedBy = {
      id: 'owner-1',
      name: 'Owner',
      email: 'owner@example.com',
    };
    const db = listDb(
      [makeAdmission({ admittedById: admittedBy.id, notes: 'admission note' })],
      [makeGrant({ grantedById: grantedBy.id, notes: 'grant note' })],
      [admittedBy, grantedBy],
    );

    const result = await listPendingAdminAdmissions(undefined, db as never);

    expect(result[0]).toMatchObject({
      invitedBy: admittedBy,
      notes: 'admission note',
    });
  });

  it('keeps canonical email keys without requiring legacy invitation joins', async () => {
    const email = 'johndoe@gmail.com';
    const db = listDb([makeAdmission({ email })], [makeGrant({ email })]);

    expect(await listPendingAdminAdmissions(undefined, db as never)).toEqual([
      expect.objectContaining({
        id: email,
        email,
        status: 'PENDING',
        catalogId: ARCHIVE.id,
        catalogLabel: ARCHIVE.label,
        role: 'reader',
        extraPermissions: [],
      }),
    ]);
  });

  it('reads only the bound pending grant without changing foreign provenance', async () => {
    const storedGrants = [
      makeGrant({
        catalogId: '20260102_000000',
        role: 'catalog_admin',
        extraPermissions: ['download_original_audio'],
        notes: 'foreign grant',
        grantedById: 'owner-2',
      }),
      makeGrant({ status: 'REVOKED', role: 'catalog_admin' }),
      makeGrant({ email: 'other@example.com', role: 'catalog_admin' }),
      makeGrant({
        extraPermissions: ['download_audio'],
        notes: 'bound grant',
        grantedById: 'owner-1',
      }),
    ];
    const originalGrants = structuredClone(storedGrants);
    const inviter = {
      id: 'owner-1',
      name: 'Bound Inviter',
      email: 'owner1@example.com',
    };
    const db = listDb(
      [makeAdmission({ notes: 'admission note' })],
      storedGrants,
      [inviter],
    );

    const result = await listPendingAdminAdmissions(undefined, db as never);

    expect(db.pendingCatalogGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'PENDING',
          catalogId: ARCHIVE.id,
          email: { in: ['pending@example.com'] },
        },
      }),
    );
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['owner-1'] } },
      select: { id: true, name: true, email: true },
    });
    expect(storedGrants).toEqual(originalGrants);
    expect(result).toEqual([
      {
        id: 'pending@example.com',
        email: 'pending@example.com',
        status: 'PENDING',
        invitedAt: ADMITTED_AT.toISOString(),
        catalogId: ARCHIVE.id,
        catalogLabel: ARCHIVE.label,
        role: 'reader',
        extraPermissions: ['download_audio'],
        invitedBy: inviter,
        notes: 'admission note',
      },
    ]);
  });

  it('counts pending portal admissions, including retained orphan rows', async () => {
    const db = { portalAdmission: { count: vi.fn().mockResolvedValue(7) } };

    expect(await countPendingPortalAdmissions(db as never)).toBe(7);
    expect(db.portalAdmission.count).toHaveBeenCalledWith({
      where: { status: 'PENDING' },
    });
  });
});

describe('pending admission detail lookup', () => {
  it('loads the canonical admission and its one bound pending grant', async () => {
    const admission = makeAdmission({ email: 'johndoe@gmail.com' });
    const grant = makeGrant({ email: admission.email });
    sharedDb.portalAdmission.findFirst.mockResolvedValue(admission);
    sharedDb.pendingCatalogGrant.findUnique.mockResolvedValue(grant);

    expect(await loadPendingAdmissionState(admission.email)).toEqual({
      admission,
      grant,
      archive: ARCHIVE,
    });
    expect(sharedDb.portalAdmission.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: admission.email, status: 'PENDING' },
      }),
    );
    expect(sharedDb.pendingCatalogGrant.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          email_catalogId: { email: admission.email, catalogId: ARCHIVE.id },
          status: 'PENDING',
        },
      }),
    );
  });

  it.each(['foreign', 'REVOKED', 'CONSUMED'])(
    'does not treat a %s grant as editable archive access',
    async (kind) => {
      const admission = makeAdmission();
      const storedGrant = makeGrant(
        kind === 'foreign'
          ? { catalogId: '20260102_000000' }
          : { status: kind as 'REVOKED' | 'CONSUMED' },
      );
      sharedDb.portalAdmission.findFirst.mockResolvedValue(admission);
      sharedDb.pendingCatalogGrant.findUnique.mockImplementation(
        async ({ where }) =>
          storedGrant.catalogId === where.email_catalogId.catalogId &&
          storedGrant.email === where.email_catalogId.email &&
          storedGrant.status === where.status
            ? storedGrant
            : null,
      );

      expect(await loadPendingAdmissionState(admission.email)).toEqual({
        admission,
        grant: null,
        archive: ARCHIVE,
      });
    },
  );
});
