import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EditMetadataContent from "@/app/catalog/[catalogId]/recording/[hash]/edit/edit-metadata-content";
import { ApiError } from "@/lib/api/fetch-json";

const useQueryMock = vi.fn();
const replaceMock = vi.fn();
const useCatalogContextMock = vi.fn();
const useRecordingEntryMock = vi.fn();

const HASH = "a".repeat(64);
const CATALOG_ID = "20260101_120000";

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => useQueryMock(options),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/use-catalog-context", () => ({
  useCatalogContext: (...args: unknown[]) => useCatalogContextMock(...args),
}));

vi.mock("@/hooks/use-recording-entry", () => ({
  useRecordingEntry: (...args: unknown[]) => useRecordingEntryMock(...args),
}));

vi.mock("@/components/metadata/metadata-editor", () => ({
  MetadataEditor: () => <div data-testid="metadata-editor" />,
}));

vi.mock("@/components/metadata/source-data-viewer", () => ({
  SourceDataViewer: () => <div data-testid="source-data-viewer" />,
}));

vi.mock("@/components/metadata/duplicates-viewer", () => ({
  DuplicatesViewer: () => <div data-testid="duplicates-viewer" />,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div data-testid="skeleton" />,
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

describe("EditMetadataContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useCatalogContextMock.mockReturnValue({
      groupKey: CATALOG_ID,
      catalogNotFound: false,
      catalogValidationLoading: false,
    });

    useRecordingEntryMock.mockReturnValue({
      data: {
        entry: {
          hash: HASH,
          filename: "recording.wav",
          hasArchived: true,
          hasMetadata: true,
          isActionable: true,
          isPublished: true,
          hasArchivedAudio: true,
          hasOriginalAudio: true,
        },
        canViewTranscripts: true,
        canEditMetadata: true,
        canDownload: true,
      },
      cachedData: undefined,
      isLoading: false,
      isValidatingAccess: false,
      error: null,
    });
  });

  it("fails closed when the details query confirms edit access was revoked", async () => {
    useQueryMock.mockReturnValue({
      data: {
        sourceMetadata: { title: "stale source" },
        sourceArchived: null,
        duplicates: [],
      },
      error: new ApiError("Edit permission required for recording details", 403),
      isLoading: false,
      isFetching: false,
    });

    const { container, queryByTestId } = render(
      <EditMetadataContent catalogId={CATALOG_ID} hash={HASH} />
    );

    expect(container.firstChild).toBeNull();
    expect(queryByTestId("metadata-editor")).toBeNull();

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(`/catalog/${CATALOG_ID}/recording/${HASH}`);
    });
  });
});
