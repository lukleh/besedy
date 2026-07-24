import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RecordingPage from "@/app/catalog/[catalogId]/recording/[hash]/page";

const mocks = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  getSessionMock: vi.fn(),
  getRecordingCapabilityMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirectMock,
  notFound: mocks.notFoundMock,
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: mocks.getSessionMock,
}));

vi.mock("@/lib/access/capabilities", () => ({
  getRecordingCapability: mocks.getRecordingCapabilityMock,
}));

vi.mock("@/app/catalog/[catalogId]/recording/[hash]/recording-content", () => ({
  default: ({
    params,
    skipCatalogValidation,
  }: {
    params: { catalogId: string; hash: string };
    skipCatalogValidation?: boolean;
  }) => (
    <div
      data-testid="recording-content"
      data-catalog-id={params.catalogId}
      data-hash={params.hash}
      data-skip-catalog-validation={String(skipCatalogValidation ?? false)}
    />
  ),
}));

describe("RecordingPage", () => {
  const catalogId = "catalog-1";
  const hash = "hash-1";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionMock.mockResolvedValue({ user: { id: "viewer-1" } });
    mocks.getRecordingCapabilityMock.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canAccessRecording: true,
    });
  });

  it("redirects unauthenticated users to sign-in", async () => {
    mocks.getSessionMock.mockResolvedValue(null);

    await expect(
      RecordingPage({
        params: Promise.resolve({ catalogId, hash }),
      })
    ).rejects.toThrow("NEXT_REDIRECT:/auth/signin");
  });

  it("returns not found when the catalog is missing", async () => {
    mocks.getRecordingCapabilityMock.mockResolvedValue({
      catalogExists: false,
      hasAccess: false,
      canAccessRecording: false,
    });

    await expect(
      RecordingPage({
        params: Promise.resolve({ catalogId, hash }),
      })
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("returns not found when the user cannot access the recording", async () => {
    mocks.getRecordingCapabilityMock.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canAccessRecording: false,
    });

    await expect(
      RecordingPage({
        params: Promise.resolve({ catalogId, hash }),
      })
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders the client content after establishing access on the server", async () => {
    const page = await RecordingPage({
      params: Promise.resolve({ catalogId, hash }),
    });

    render(page);

    const content = screen.getByTestId("recording-content");
    expect(content).toHaveAttribute("data-catalog-id", catalogId);
    expect(content).toHaveAttribute("data-hash", hash);
    expect(content).toHaveAttribute("data-skip-catalog-validation", "true");
    expect(mocks.getRecordingCapabilityMock).toHaveBeenCalledWith(
      catalogId,
      hash,
      "viewer-1"
    );
  });
});
