import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AuditDetailContent from "@/app/admin/audit/[id]/audit-detail-content";
import { fetchJson } from "@/lib/api/fetch-json";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "log-1" }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
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

vi.mock("@/lib/api/fetch-json", () => ({
  ApiError: class MockApiError extends Error {
    status: number;

    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
  fetchJson: vi.fn(),
}));

function renderAuditDetail() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AuditDetailContent />
    </QueryClientProvider>
  );
}

describe("AuditDetailContent", () => {
  const fetchJsonMock = vi.mocked(fetchJson);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders reopened grant breakdowns for reset actions", async () => {
    fetchJsonMock.mockResolvedValueOnce({
      id: "log-1",
      userId: "admin-1",
      action: "PORTAL_ADMISSION_RESET",
      resource: "portal_admission",
      resourceId: "portal-1",
      details: {
        email: "pending@example.com",
        pendingGrantCount: 2,
        reopenedGrants: [
          { catalogId: "20260101_000000", accessLevel: "EDITOR" },
          { catalogId: "20260102_000000", accessLevel: "VIEWER" },
        ],
      },
      ipAddress: null,
      userAgent: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      user: null,
      relatedEntity: null,
    });

    renderAuditDetail();

    expect(await screen.findByText("Reopened catalog grants")).toBeInTheDocument();
    expect(screen.getByText("20260101_000000")).toBeInTheDocument();
    expect(screen.getByText("20260102_000000")).toBeInTheDocument();
    expect(screen.getByText("VIEWER")).toBeInTheDocument();
  });

  it("renders claimed grant breakdowns for claim actions", async () => {
    fetchJsonMock.mockResolvedValueOnce({
      id: "log-1",
      userId: "user-1",
      action: "PORTAL_ADMISSION_CLAIMED",
      resource: "portal_admission",
      resourceId: "portal-1",
      details: {
        email: "claimed@example.com",
        pendingGrantCount: 2,
        grants: [
          { catalogId: "20260103_000000", accessLevel: "MEMBER" },
          { catalogId: "20260104_000000", accessLevel: "EDITOR" },
        ],
      },
      ipAddress: null,
      userAgent: null,
      createdAt: "2026-03-10T13:00:00.000Z",
      user: null,
      relatedEntity: null,
    });

    renderAuditDetail();

    expect(await screen.findByText("Claimed catalog grants")).toBeInTheDocument();
    expect(screen.getByText("20260103_000000")).toBeInTheDocument();
    expect(screen.getByText("20260104_000000")).toBeInTheDocument();
    expect(screen.getByText("MEMBER")).toBeInTheDocument();
  });
});
