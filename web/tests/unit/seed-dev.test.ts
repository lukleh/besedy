import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TEST_USERS } from "../../prisma/test-data";

const mocks = vi.hoisted(() => ({
  prisma: {
    workflowGroup: { findUnique: vi.fn() },
    user: { upsert: vi.fn(), findUnique: vi.fn() },
    $disconnect: vi.fn(),
  },
  syncSeedPendingAdmissions: vi.fn(),
}));

vi.mock("@/generated/prisma/client", () => ({
  PrismaClient: class {
    constructor() {
      return mocks.prisma;
    }
  },
}));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: class {} }));
vi.mock("../../prisma/seed-pending-admissions", () => ({
  syncSeedPendingAdmissions: mocks.syncSeedPendingAdmissions,
}));
vi.mock("@/lib/archive", async (original) => ({
  ...(await original<typeof import("@/lib/archive")>()),
  requireArchiveId: () => "20260101_000000",
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mocks.prisma.workflowGroup.findUnique.mockResolvedValue({
    id: "20260101_000000",
    isActive: true,
  });
  mocks.prisma.user.upsert.mockImplementation(async ({ create }) => ({
    id: create.email,
  }));
  mocks.prisma.user.findUnique.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("seeds status fixtures directly and invites only users with content access", async () => {
  const finished = new Promise<void>((resolve) => {
    mocks.prisma.$disconnect.mockImplementation(async () => resolve());
  });

  await import("../../prisma/seed-dev");
  await finished;

  for (const [email, status] of [
    [TEST_USERS.noaccess.email, "ACTIVE"],
    [TEST_USERS.mutation.email, "ACTIVE"],
    [TEST_USERS.pending.email, "PENDING"],
    [TEST_USERS.blocked.email, "BLOCKED"],
  ]) {
    expect(mocks.prisma.user.upsert).toHaveBeenCalledWith({
      where: { email },
      update: expect.objectContaining({
        status,
        isAdmin: false,
        isSuperadmin: false,
      }),
      create: expect.objectContaining({
        email,
        status,
        isAdmin: false,
        isSuperadmin: false,
        activatedAt: status === "ACTIVE" ? expect.any(Date) : null,
      }),
    });
  }

  expect(mocks.syncSeedPendingAdmissions).toHaveBeenCalledTimes(5);
  expect(
    mocks.syncSeedPendingAdmissions.mock.calls.map(([, input]) => ({
      email: input.email,
      catalogId: input.catalogId,
      role: input.role,
    })),
  ).toEqual([
    {
      email: TEST_USERS.owner.email,
      catalogId: "20260101_000000",
      role: "host",
    },
    {
      email: TEST_USERS.editor.email,
      catalogId: "20260101_000000",
      role: "curator",
    },
    {
      email: TEST_USERS.member.email,
      catalogId: "20260101_000000",
      role: "reader",
    },
    {
      email: TEST_USERS.viewer.email,
      catalogId: "20260101_000000",
      role: "reader",
    },
    {
      email: TEST_USERS.listener.email,
      catalogId: "20260101_000000",
      role: "listener",
    },
  ]);
});
