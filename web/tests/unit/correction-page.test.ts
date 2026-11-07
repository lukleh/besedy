import { beforeEach, describe, expect, it, vi } from "vitest";
import CorrectionPage from "@/app/(app)/catalog/[catalogId]/recording/[hash]/correction/page";
import { grantForRole } from "@/lib/policy/catalog-permissions";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getRecordingCapability: vi.fn(),
  isPublishedVisibleEvent: vi.fn(),
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
  default: { catalogEventRecording: { findUnique: mocks.findAssignment } },
}));
vi.mock("@/lib/catalog-events/visibility", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/catalog-events/visibility")>(),
  isPublishedVisibleEvent: mocks.isPublishedVisibleEvent,
}));
vi.mock("@/components/correction/correction-workspace", () => ({
  CorrectionWorkspace: () => null,
}));

const catalogId = "20251225_120000";
const hash = "a".repeat(64);
const params = () => Promise.resolve({ catalogId, hash });

function capability(overrides: Record<string, unknown> = {}) {
  return {
    catalogExists: true,
    hasAccess: true,
    canAccessRecording: true,
    canCorrectTranscripts: true,
    canPublishTranscript: false,
    catalogGrant: grantForRole("listener"),
    ...overrides,
  };
}

describe("CorrectionPage event link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getRecordingCapability.mockResolvedValue(capability());
    mocks.findAssignment.mockResolvedValue({ eventId: 42 });
    mocks.isPublishedVisibleEvent.mockResolvedValue(true);
  });

  it("links to the assigned event when it is visible to a released-scope grant", async () => {
    const page = await CorrectionPage({ params: params() });

    expect(page.props.eventId).toBe(42);
    expect(mocks.findAssignment).toHaveBeenCalledWith({
      where: { workflowGroupId_audioHash: { workflowGroupId: catalogId, audioHash: hash } },
      select: { eventId: true },
    });
    expect(mocks.isPublishedVisibleEvent).toHaveBeenCalledWith(expect.anything(), catalogId, 42);
  });

  it("omits the link when the assigned event is outside the visibility scope", async () => {
    mocks.isPublishedVisibleEvent.mockResolvedValue(false);

    const page = await CorrectionPage({ params: params() });

    expect(page.props.eventId).toBeNull();
  });

  it("omits the link and skips the visibility check without an assignment", async () => {
    mocks.findAssignment.mockResolvedValue(null);

    const page = await CorrectionPage({ params: params() });

    expect(page.props.eventId).toBeNull();
    expect(mocks.isPublishedVisibleEvent).not.toHaveBeenCalled();
  });

  it("skips the visibility check for grants that see unreleased events", async () => {
    mocks.getRecordingCapability.mockResolvedValue(
      capability({ catalogGrant: grantForRole("curator") }),
    );

    const page = await CorrectionPage({ params: params() });

    expect(page.props.eventId).toBe(42);
    expect(mocks.isPublishedVisibleEvent).not.toHaveBeenCalled();
  });

  it("requires sign-in before looking up the recording's event", async () => {
    mocks.getSession.mockResolvedValue(null);

    await expect(CorrectionPage({ params: params() })).rejects.toThrow("NEXT_REDIRECT:/auth/signin");
    expect(mocks.findAssignment).not.toHaveBeenCalled();
  });

  it("requires correction access before looking up the recording's event", async () => {
    mocks.getRecordingCapability.mockResolvedValue(
      capability({ canCorrectTranscripts: false, canPublishTranscript: undefined, catalogGrant: undefined }),
    );

    await expect(CorrectionPage({ params: params() })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.findAssignment).not.toHaveBeenCalled();
  });
});
