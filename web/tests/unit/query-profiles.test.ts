import { describe, expect, it } from "vitest";
import { ApiError, SchemaValidationError } from "@/lib/api/fetch-json";
import {
  ADMIN_STATUS_QUERY_PROFILE,
  AUTH_SENSITIVE_QUERY_PROFILE,
  FIVE_MINUTE_QUERY_PROFILE,
  FRESH_QUERY_PROFILE,
  ONE_MINUTE_QUERY_PROFILE,
  QUERY_CLIENT_DEFAULT_OPTIONS,
  SESSION_STATIC_QUERY_PROFILE,
  shouldRetryQuery,
} from "@/lib/query/profiles";

describe("query profiles", () => {
  it("keeps the fresh and auth-sensitive profiles aligned", () => {
    expect(AUTH_SENSITIVE_QUERY_PROFILE).toEqual(FRESH_QUERY_PROFILE);
  });

  it("preserves remount-refreshing timed profiles", () => {
    expect(ONE_MINUTE_QUERY_PROFILE).toEqual({
      staleTime: 60_000,
      gcTime: 0,
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
    });

    expect(FIVE_MINUTE_QUERY_PROFILE).toEqual({
      staleTime: 5 * 60_000,
      gcTime: 0,
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
    });
  });

  it("preserves the longer-lived special cases", () => {
    expect(ADMIN_STATUS_QUERY_PROFILE).toEqual({
      staleTime: 5 * 60_000,
      gcTime: 10 * 60_000,
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
    });

    expect(SESSION_STATIC_QUERY_PROFILE).toEqual({
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 0,
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
    });
  });
});

describe("default query retry", () => {
  it("is the client-wide default", () => {
    expect(QUERY_CLIENT_DEFAULT_OPTIONS.queries.retry).toBe(shouldRetryQuery);
  });

  it("does not retry final client errors", () => {
    for (const status of [400, 401, 403, 404, 410]) {
      expect(shouldRetryQuery(0, new ApiError("client error", status))).toBe(false);
    }
  });

  it("does not retry a payload that fails its schema", () => {
    expect(
      shouldRetryQuery(0, new SchemaValidationError("Invalid response payload", null, []))
    ).toBe(false);
  });

  it("retries temporary failures up to three times", () => {
    const temporary = [
      new ApiError("Request Timeout", 408),
      new ApiError("Too Many Requests", 429),
      new ApiError("Internal error", 500),
      new TypeError("Failed to fetch"),
    ];
    for (const error of temporary) {
      expect(shouldRetryQuery(0, error)).toBe(true);
      expect(shouldRetryQuery(2, error)).toBe(true);
      expect(shouldRetryQuery(3, error)).toBe(false);
    }
  });
});
