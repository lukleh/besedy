import { beforeEach, describe, expect, it, vi } from "vitest";
import CorrectionPage from "@/app/(app)/catalog/[catalogId]/recording/[hash]/correction/page";
import { grantForRole } from "@/lib/policy/catalog-permissions";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getRecordingCapability: vi.fn(),
  resolveReadableEventIds: vi.fn(),
  findAssignment: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/access/capabilities", () => ({
  getRecordingCapability: mocks.getRecordingCapability,
}));
vi.mock("@/lib/db", () => ({
  default: { catalogEventRecording: { findFirst: mocks.findAssignment } },
}));
vi.mock("@/lib/catalog-events/read-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/catalog-events/read-service")>(),
  resolveReadableEventIds: mocks.resolveReadableEventIds,
}));
vi.mock("@/components/correction/correction-workspace", () => ({
  CorrectionWorkspace: () => null,
}));

const catalogId = "20251225_120000";
const hash = "a".repeat(64);
const catalogGrant = grantForRole("listener");
const params = () => Promise.resolve({ catalogId, hash });

describe("CorrectionPage event link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getRecordingCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canAccessRecording: true,
      canCorrectTranscripts: true,
      canPublishTranscript: false,
      catalogGrant,
    });
    mocks.resolveReadableEventIds.mockResolvedValue([42]);
    mocks.findAssignment.mockResolvedValue({ eventId: 42 });
  });

  it("links only to an assigned event within the user's event visibility scope", async () => {
    const page = await CorrectionPage({ params: params() });

    expect(page.props.eventId).toBe(42);
    expect(mocks.resolveReadableEventIds).toHaveBeenCalledWith(catalogId, catalogGrant);
    expect(mocks.findAssignment).toHaveBeenCalledWith({
      where: { workflowGroupId: catalogId, audioHash: hash, eventId: { in: [42] } },
      select: { eventId: true },
    });
  });

  it("omits the event link when the assignment is absent or outside the visibility scope", async () => {
    mocks.resolveReadableEventIds.mockResolvedValue([]);
    mocks.findAssignment.mockResolvedValue(null);

    const page = await CorrectionPage({ params: params() });

    expect(page.props.eventId).toBeNull();
    expect(mocks.findAssignment.mock.calls[0][0].where.eventId.in).not.toContain(42);
  });

  it("keeps the catalog and recording scope for users who can see unreleased events", async () => {
    mocks.resolveReadableEventIds.mockResolvedValue(null);

    const page = await CorrectionPage({ params: params() });

    expect(page.props.eventId).toBe(42);
    expect(mocks.findAssignment).toHaveBeenCalledWith({
      where: { workflowGroupId: catalogId, audioHash: hash },
      select: { eventId: true },
    });
  });

  it("requires sign-in before looking up the recording's event", async () => {
    mocks.getSession.mockResolvedValue(null);

    await expect(CorrectionPage({ params: params() })).rejects.toThrow("NEXT_REDIRECT:/auth/signin");
    expect(mocks.findAssignment).not.toHaveBeenCalled();
    expect(mocks.resolveReadableEventIds).not.toHaveBeenCalled();
  });

  it("requires correction access before looking up the recording's event", async () => {
    mocks.getRecordingCapability.mockResolvedValue({
      catalogExists: true, hasAccess: true, canAccessRecording: true, canCorrectTranscripts: false,
    });

    await expect(CorrectionPage({ params: params() })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.findAssignment).not.toHaveBeenCalled();
    expect(mocks.resolveReadableEventIds).not.toHaveBeenCalled();
  });
});
