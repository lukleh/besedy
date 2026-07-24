import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getJobs, POST as postJob } from "@/app/api/catalogs/[id]/deep-search/jobs/route";
import { GET as getJob } from "@/app/api/catalogs/[id]/deep-search/jobs/[jobId]/route";
import { POST as cancelJob } from "@/app/api/catalogs/[id]/deep-search/jobs/[jobId]/cancel/route";
import {
  GET as getShares,
  POST as postShare,
} from "@/app/api/catalogs/[id]/deep-search/jobs/[jobId]/shares/route";
import { GET as searchShareUsers } from "@/app/api/catalogs/[id]/deep-search/jobs/[jobId]/share-users/route";
import type { DeepSearchJob } from "@/lib/jobs-api/schemas";
import prisma from "@/lib/db";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
  AuthError: class AuthError extends Error {
    statusCode: number;

    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

vi.mock("@/lib/features/capabilities", () => ({
  canAccessCatalogDeepSearch: vi.fn(),
  getLabsPreferenceForUser: vi.fn(),
  isFeatureEnabledForUser: vi.fn(),
}));

vi.mock("@/lib/access/capabilities", () => ({
  getCatalogCapability: vi.fn(),
}));

vi.mock("@/lib/jobs-api/server", () => ({
  fetchJobsApi: vi.fn(),
  JobsApiConfigurationError: class JobsApiConfigurationError extends Error {},
  JobsApiError: class JobsApiError extends Error {
    status: number;
    payload: unknown;

    constructor(message: string, status: number, payload: unknown) {
      super(message);
      this.status = status;
      this.payload = payload;
    }
  },
}));

vi.mock("@/lib/db", () => ({
  default: {
    deepSearchJobShare: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
  },
}));

const catalogId = "20260201_120000";
const jobId = "00000000-0000-4000-8000-000000000001";

function deepSearchJob(overrides: Partial<DeepSearchJob> = {}): DeepSearchJob {
  return {
    id: jobId,
    kind: "DEEP_SEARCH",
    status: "RUNNING",
    requested_by_id: "user-1",
    catalog_id: catalogId,
    payload: {
      query: "who mentions Brno?",
      instructions: "Write a report",
      retrieval: { top_k: 10 },
      execution: {},
    },
    result: null,
    result_preview: null,
    error_code: null,
    error_message: null,
    progress_label: null,
    progress_pct: null,
    created_at: null,
    started_at: null,
    finished_at: null,
    updated_at: null,
    prefectStateName: "Running",
    prefectStateType: "RUNNING",
    prefectFlowRunId: jobId,
    prefectDeploymentId: null,
    prefectWorkPoolName: "besedy-deep-search",
    artifacts: [],
    outputBundle: {},
    ...overrides,
  };
}

function routeParams(id = catalogId, resolvedJobId = jobId) {
  return {
    params: Promise.resolve({ id, jobId: resolvedJobId }),
  };
}

function mutationRequest(url: string, body?: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("deep-search proxy routes", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let canAccessCatalogDeepSearch: ReturnType<typeof vi.fn>;
  let getCatalogCapability: ReturnType<typeof vi.fn>;
  let getLabsPreferenceForUser: ReturnType<typeof vi.fn>;
  let isFeatureEnabledForUser: ReturnType<typeof vi.fn>;
  let fetchJobsApi: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    requireAuth = (await import("@/lib/auth/permissions")).requireAuth as ReturnType<typeof vi.fn>;
    canAccessCatalogDeepSearch = (await import("@/lib/features/capabilities"))
      .canAccessCatalogDeepSearch as ReturnType<typeof vi.fn>;
    getLabsPreferenceForUser = (await import("@/lib/features/capabilities"))
      .getLabsPreferenceForUser as ReturnType<typeof vi.fn>;
    isFeatureEnabledForUser = (await import("@/lib/features/capabilities"))
      .isFeatureEnabledForUser as ReturnType<typeof vi.fn>;
    getCatalogCapability = (await import("@/lib/access/capabilities"))
      .getCatalogCapability as ReturnType<typeof vi.fn>;
    fetchJobsApi = (await import("@/lib/jobs-api/server")).fetchJobsApi as ReturnType<typeof vi.fn>;
    requireAuth.mockResolvedValue("user-1");
    canAccessCatalogDeepSearch.mockResolvedValue(true);
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
    });
    getLabsPreferenceForUser.mockResolvedValue({ enabled: true });
    isFeatureEnabledForUser.mockReturnValue(true);
    vi.mocked(prisma.deepSearchJobShare.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.deepSearchJobShare.findMany).mockResolvedValue([]);
    vi.mocked(prisma.deepSearchJobShare.deleteMany).mockResolvedValue({ count: 1 } as never);
  });

  it("injects the authenticated user when submitting a job", async () => {
    fetchJobsApi.mockResolvedValue(deepSearchJob());

    const response = await postJob(
      mutationRequest(`http://localhost/api/catalogs/${catalogId}/deep-search/jobs`, {
        query: " who mentions Brno? ",
        requestedById: "attacker",
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    expect(fetchJobsApi).toHaveBeenCalledWith(
      `/catalogs/${catalogId}/deep-search/jobs`,
      expect.objectContaining({
        method: "POST",
        body: {
          query: "who mentions Brno?",
          requestedById: "user-1",
          callerScope: "user-1",
        },
      })
    );
  });

  it("rejects job submission without a query", async () => {
    const response = await postJob(
      mutationRequest(`http://localhost/api/catalogs/${catalogId}/deep-search/jobs`, {
        query: "",
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(400);
    expect(fetchJobsApi).not.toHaveBeenCalled();
  });

  it("rejects job submission with an empty report instructions", async () => {
    const response = await postJob(
      mutationRequest(`http://localhost/api/catalogs/${catalogId}/deep-search/jobs`, {
        query: "who mentions Brno?",
        instructions: " ",
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(400);
    expect(fetchJobsApi).not.toHaveBeenCalled();
  });

  it("rejects job submission with the removed form field", async () => {
    const response = await postJob(
      mutationRequest(`http://localhost/api/catalogs/${catalogId}/deep-search/jobs`, {
        query: "who mentions Brno?",
        form: "Return a table",
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(400);
    expect(fetchJobsApi).not.toHaveBeenCalled();
  });

  it("trims the query when submitting a job", async () => {
    fetchJobsApi.mockResolvedValue(deepSearchJob());

    const response = await postJob(
      mutationRequest(`http://localhost/api/catalogs/${catalogId}/deep-search/jobs`, {
        query: " who mentions Brno? ",
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    expect(fetchJobsApi).toHaveBeenCalledWith(
      `/catalogs/${catalogId}/deep-search/jobs`,
      expect.objectContaining({
        method: "POST",
        body: {
          query: "who mentions Brno?",
          requestedById: "user-1",
          callerScope: "user-1",
        },
      })
    );
  });

  it("trims and forwards the optional report instructions when submitting a job", async () => {
    fetchJobsApi.mockResolvedValue(
      deepSearchJob({
        payload: {
          query: "who mentions Brno?",
          instructions: "Return a table",
          retrieval: { top_k: 10 },
          execution: {},
        },
      })
    );

    const response = await postJob(
      mutationRequest(`http://localhost/api/catalogs/${catalogId}/deep-search/jobs`, {
        query: " who mentions Brno? ",
        instructions: " Return a table ",
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    expect(fetchJobsApi).toHaveBeenCalledWith(
      `/catalogs/${catalogId}/deep-search/jobs`,
      expect.objectContaining({
        method: "POST",
        body: {
          query: "who mentions Brno?",
          instructions: "Return a table",
          requestedById: "user-1",
          callerScope: "user-1",
        },
      })
    );
  });

  it("post-filters listed jobs to the current catalog and user", async () => {
    fetchJobsApi.mockResolvedValue({
      jobs: [
        deepSearchJob(),
        deepSearchJob({ id: "00000000-0000-4000-8000-000000000002", requested_by_id: "other" }),
        deepSearchJob({ id: "00000000-0000-4000-8000-000000000003", catalog_id: "20260202_120000" }),
      ],
    });

    const response = await getJobs(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/deep-search/jobs`),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].id).toBe(jobId);
  });

  it("hides a job detail when ownership does not match", async () => {
    fetchJobsApi.mockResolvedValue(deepSearchJob({ requested_by_id: "other" }));

    const response = await getJob(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/deep-search/jobs/${jobId}`),
      routeParams()
    );

    expect(response.status).toBe(404);
  });

  it("allows reading a shared job detail when the current user has a share", async () => {
    vi.mocked(prisma.deepSearchJobShare.findUnique).mockResolvedValue({
      id: "share-1",
      catalogId,
    } as never);
    fetchJobsApi.mockResolvedValue(deepSearchJob({ requested_by_id: "owner-1" }));

    const response = await getJob(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/deep-search/jobs/${jobId}`),
      routeParams()
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.access).toBe("shared");
  });

  it("checks ownership before forwarding cancellation", async () => {
    fetchJobsApi
      .mockResolvedValueOnce(deepSearchJob())
      .mockResolvedValueOnce(deepSearchJob({ status: "CANCELLED" }));

    const response = await cancelJob(
      mutationRequest(
        `http://localhost/api/catalogs/${catalogId}/deep-search/jobs/${jobId}/cancel`
      ),
      routeParams()
    );

    expect(response.status).toBe(200);
    expect(fetchJobsApi).toHaveBeenNthCalledWith(
      1,
      `/jobs/${jobId}`,
      expect.any(Object)
    );
    expect(fetchJobsApi).toHaveBeenNthCalledWith(
      2,
      `/jobs/${jobId}/cancel`,
      expect.objectContaining({ method: "POST" })
    );
  });

  it("does not call jobs-api when the catalog deep-search gate fails", async () => {
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: false,
    });

    const response = await getJobs(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/deep-search/jobs`),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(404);
    expect(fetchJobsApi).not.toHaveBeenCalled();
  });

  it("lists jobs shared with the current user", async () => {
    const sharedJobId = "00000000-0000-4000-8000-000000000004";
    vi.mocked(prisma.deepSearchJobShare.findMany).mockResolvedValue([
      {
        jobId: sharedJobId,
        catalogId,
        ownerUserId: "owner-1",
        sharedWithUserId: "user-1",
        createdAt: new Date("2026-04-26T12:00:00.000Z"),
        sharedByUser: {
          id: "owner-1",
          name: "Owner",
          email: "owner@example.test",
          image: null,
        },
      },
    ] as never);
    fetchJobsApi.mockResolvedValue(
      deepSearchJob({
        id: sharedJobId,
        requested_by_id: "owner-1",
      })
    );

    const response = await getJobs(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/deep-search/jobs?scope=shared`),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({
      id: sharedJobId,
      access: "shared",
      sharedBy: { id: "owner-1" },
    });
  });

  it("creates a share only for a user with catalog access", async () => {
    fetchJobsApi.mockResolvedValue(deepSearchJob());
    getCatalogCapability.mockImplementation((_catalogId: string, checkedUserId: string) =>
      Promise.resolve({
        catalogExists: true,
        hasAccess: checkedUserId === "user-2" || checkedUserId === "user-1",
      })
    );
    vi.mocked(prisma.deepSearchJobShare.upsert).mockResolvedValue({
      id: "share-1",
      jobId,
      catalogId,
      ownerUserId: "user-1",
      sharedWithUserId: "user-2",
      createdAt: new Date("2026-04-26T12:00:00.000Z"),
      sharedWithUser: {
        id: "user-2",
        name: "Reader",
        email: "reader@example.test",
        image: null,
      },
    } as never);

    const response = await postShare(
      mutationRequest(
        `http://localhost/api/catalogs/${catalogId}/deep-search/jobs/${jobId}/shares`,
        { userId: "user-2" }
      ),
      routeParams()
    );

    expect(response.status).toBe(200);
    expect(prisma.deepSearchJobShare.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          jobId,
          catalogId,
          ownerUserId: "user-1",
          sharedWithUserId: "user-2",
        }),
      })
    );
  });

  it("searches share recipients only among users with same catalog access", async () => {
    fetchJobsApi.mockResolvedValue(deepSearchJob());
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      {
        id: "user-2",
        name: "Reader",
        email: "reader@example.test",
        image: null,
      },
    ] as never);

    const response = await searchShareUsers(
      new NextRequest(
        `http://localhost/api/catalogs/${catalogId}/deep-search/jobs/${jobId}/share-users?search=read`
      ),
      routeParams()
    );

    expect(response.status).toBe(200);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            {
              OR: expect.arrayContaining([
                expect.objectContaining({
                  catalogAccess: {
                    some: {
                      catalogId,
                      status: "ACTIVE",
                    },
                  },
                }),
              ]),
            },
          ],
        }),
      })
    );
  });

  it("returns current shares for the owner", async () => {
    fetchJobsApi.mockResolvedValue(deepSearchJob());
    vi.mocked(prisma.deepSearchJobShare.findMany).mockResolvedValue([
      {
        id: "share-1",
        jobId,
        catalogId,
        ownerUserId: "user-1",
        sharedWithUserId: "user-2",
        createdAt: new Date("2026-04-26T12:00:00.000Z"),
        sharedWithUser: {
          id: "user-2",
          name: "Reader",
          email: "reader@example.test",
          image: null,
        },
      },
    ] as never);

    const response = await getShares(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/deep-search/jobs/${jobId}/shares`),
      routeParams()
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.shares).toHaveLength(1);
    expect(body.shares[0].user.email).toBe("reader@example.test");
  });
});
