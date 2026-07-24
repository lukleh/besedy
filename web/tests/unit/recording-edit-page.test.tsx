import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EditMetadataPage from "@/app/catalog/[catalogId]/recording/[hash]/edit/page";

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

vi.mock(
  "@/app/catalog/[catalogId]/recording/[hash]/edit/edit-metadata-content",
  () => ({
    default: ({
      catalogId,
      hash,
      skipCatalogValidation,
    }: {
      catalogId: string;
      hash: string;
      skipCatalogValidation?: boolean;
    }) => (
      <div
        data-testid="edit-metadata-content"
        data-catalog-id={catalogId}
        data-hash={hash}
        data-skip-catalog-validation={String(skipCatalogValidation ?? false)}
      />
    ),
  })
);

describe("EditMetadataPage", () => {
  const catalogId = "catalog-1";
  const hash = "hash-1";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionMock.mockResolvedValue({ user: { id: "editor-1" } });
    mocks.getRecordingCapabilityMock.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canAccessRecording: true,
      canEditRecording: true,
    });
  });

  it("redirects unauthenticated users to sign-in", async () => {
    mocks.getSessionMock.mockResolvedValue(null);

    await expect(
      EditMetadataPage({
        params: Promise.resolve({ catalogId, hash }),
      })
    ).rejects.toThrow("NEXT_REDIRECT:/auth/signin");
  });

  it("returns not found when the recording is not accessible", async () => {
    mocks.getRecordingCapabilityMock.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canAccessRecording: false,
      canEditRecording: false,
    });

    await expect(
      EditMetadataPage({
        params: Promise.resolve({ catalogId, hash }),
      })
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("redirects read-only users back to the recording page", async () => {
    mocks.getRecordingCapabilityMock.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canAccessRecording: true,
      canEditRecording: false,
    });

    await expect(
      EditMetadataPage({
        params: Promise.resolve({ catalogId, hash }),
      })
    ).rejects.toThrow(`NEXT_REDIRECT:/catalog/${catalogId}/recording/${hash}`);
  });

  it("renders the edit content after establishing edit access on the server", async () => {
    const page = await EditMetadataPage({
      params: Promise.resolve({ catalogId, hash }),
    });

    render(page);

    const content = screen.getByTestId("edit-metadata-content");
    expect(content).toHaveAttribute("data-catalog-id", catalogId);
    expect(content).toHaveAttribute("data-hash", hash);
    expect(content).toHaveAttribute("data-skip-catalog-validation", "true");
    expect(mocks.getRecordingCapabilityMock).toHaveBeenCalledWith(
      catalogId,
      hash,
      "editor-1"
    );
  });
});
