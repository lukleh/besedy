import { describe, expect, it } from "vitest";
import {
  ADMIN_STATUS_QUERY_PROFILE,
  AUTH_SENSITIVE_QUERY_PROFILE,
  FIVE_MINUTE_QUERY_PROFILE,
  FRESH_QUERY_PROFILE,
  ONE_MINUTE_QUERY_PROFILE,
  SESSION_STATIC_QUERY_PROFILE,
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
