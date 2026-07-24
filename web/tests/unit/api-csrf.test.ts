import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { validateMutationSource } from "@/lib/api/csrf";

describe("validateMutationSource", () => {
  const originalAppEnv = process.env.APP_ENV;

  afterEach(() => {
    if (originalAppEnv === undefined) {
      delete process.env.APP_ENV;
      return;
    }

    process.env.APP_ENV = originalAppEnv;
  });

  it("allows same-origin requests via Origin", async () => {
    const request = new NextRequest("http://localhost/api/catalogs", {
      method: "POST",
      headers: { Origin: "http://localhost" },
    });

    expect(validateMutationSource(request)).toBeNull();
  });

  it("allows same-origin requests via Referer when Origin is missing", async () => {
    const request = new NextRequest("http://localhost/api/catalogs", {
      method: "POST",
      headers: { Referer: "http://localhost/catalog/20260101_120000/settings" },
    });

    expect(validateMutationSource(request)).toBeNull();
  });

  it("rejects requests without a trusted source header", async () => {
    process.env.APP_ENV = "production";
    const request = new NextRequest("http://localhost/api/catalogs", {
      method: "POST",
    });

    const response = validateMutationSource(request);
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Invalid request origin",
      code: "FORBIDDEN",
    });
  });

  it("rejects requests from an untrusted origin", async () => {
    process.env.APP_ENV = "production";
    const request = new NextRequest("http://localhost/api/catalogs", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });

    const response = validateMutationSource(request);
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Invalid request origin",
      code: "FORBIDDEN",
    });
  });

  it("allows missing source headers in the test app environment", async () => {
    process.env.APP_ENV = "test";
    const request = new NextRequest("http://localhost/api/catalogs", {
      method: "POST",
    });

    expect(validateMutationSource(request)).toBeNull();
  });
});
