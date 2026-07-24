"use client";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import manifest from "@/app/manifest";

describe("manifest", () => {
  const originalAuthUrl = process.env.AUTH_URL;
  const originalNextPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    process.env.AUTH_URL = originalAuthUrl;
    process.env.NEXT_PUBLIC_APP_URL = originalNextPublicAppUrl;
  });

  afterEach(() => {
    if (originalAuthUrl === undefined) {
      delete process.env.AUTH_URL;
    } else {
      process.env.AUTH_URL = originalAuthUrl;
    }
    if (originalNextPublicAppUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalNextPublicAppUrl;
    }
  });

  it("includes absolute related_applications id when AUTH_URL is set", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.AUTH_URL = "https://besedy.example.com";

    const result = manifest();
    const relatedApp = result.related_applications?.[0];

    expect(relatedApp?.url).toBe("/manifest.webmanifest");
    expect(relatedApp?.id).toBe(
      "https://besedy.example.com/manifest.webmanifest"
    );
  });

  it("prefers NEXT_PUBLIC_APP_URL over AUTH_URL", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    process.env.AUTH_URL = "https://besedy.example.com";

    const result = manifest();
    const relatedApp = result.related_applications?.[0];

    expect(relatedApp?.id).toBe(
      "https://app.example.com/manifest.webmanifest"
    );
  });

  it("normalizes trailing slash in AUTH_URL", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.AUTH_URL = "https://besedy.example.com/";

    const result = manifest();
    const relatedApp = result.related_applications?.[0];

    expect(relatedApp?.id).toBe(
      "https://besedy.example.com/manifest.webmanifest"
    );
  });

  it("omits related_applications id when no base URL is set", () => {
    delete process.env.AUTH_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;

    const result = manifest();
    const relatedApp = result.related_applications?.[0];

    expect(relatedApp?.id).toBeUndefined();
  });
});
