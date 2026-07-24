import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, SchemaValidationError, fetchJson } from "@/lib/api/fetch-json";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchJson auth redirect behavior", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.spyOn(globalThis, "fetch");
    window.history.pushState({}, "", "/catalog/20251225_120000?q=test");
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it("redirects to sign-in on 401 without extra auth probe", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: "Authentication required" })
    );

    await expect(fetchJson("/api/catalogs")).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses no-store for GET requests by default", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await expect(fetchJson<{ ok: boolean }>("/api/catalogs")).resolves.toEqual({
      ok: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/catalogs",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("does not redirect on 403", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: "Access denied" }));

    await expect(
      fetchJson("/api/transcript/hash/formats?backend=test/model")
    ).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws ApiError on 403 without additional requests", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: "Access denied" }));

    await expect(fetchJson("/api/catalogs/20260101_120000/access")).rejects.toBeInstanceOf(
      ApiError
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("respects skipAuthCheck and never redirects", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: "Access denied" }));

    await expect(
      fetchJson("/api/catalogs", { skipAuthCheck: true })
    ).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates successful responses against an optional schema", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { canManageAccess: true })
    );

    await expect(
      fetchJson("/api/catalogs/20260101_120000/capability", {
        schema: z.object({ canManageAccess: z.boolean() }),
      })
    ).resolves.toEqual({ canManageAccess: true });
  });

  it("throws ApiError when response validation fails", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { canManageAccess: "yes" })
    );

    await expect(
      fetchJson("/api/catalogs/20260101_120000/capability", {
        schema: z.object({ canManageAccess: z.boolean() }),
      })
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("distinguishes schema failures from HTTP failures via SchemaValidationError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { canManageAccess: "yes" })
    );

    const error = await fetchJson("/api/catalogs/20260101_120000/capability", {
      schema: z.object({ canManageAccess: z.boolean() }),
    }).catch((err) => err);

    expect(error).toBeInstanceOf(SchemaValidationError);
    expect(error).toBeInstanceOf(ApiError);
    // Sentinel status so callers filtering on HTTP ranges don't misclassify
    // a contract mismatch as a 5xx server error.
    expect(error.status).toBe(0);
    expect(error.issues).toHaveLength(1);
  });

  it("skips JSON parsing for expected empty responses", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      fetchJson<null>("/api/notifications/subscribe", {
        method: "DELETE",
      })
    ).resolves.toBeNull();

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
