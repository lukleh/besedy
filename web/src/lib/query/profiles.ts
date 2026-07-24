// Query updates should be driven by navigation, explicit invalidation, or
// polling where needed, not by every tab focus event.
const REMOUNT_REFRESH_QUERY_PROFILE = {
  gcTime: 0,
  refetchOnMount: "always" as const,
  refetchOnWindowFocus: false,
};

export const FRESH_QUERY_PROFILE = {
  staleTime: 0,
  ...REMOUNT_REFRESH_QUERY_PROFILE,
};

export const DEFAULT_QUERY_PROFILE = FRESH_QUERY_PROFILE;

export const AUTH_SENSITIVE_QUERY_PROFILE = FRESH_QUERY_PROFILE;

export const ONE_MINUTE_QUERY_PROFILE = {
  staleTime: 60_000,
  ...REMOUNT_REFRESH_QUERY_PROFILE,
};

export const FIVE_MINUTE_QUERY_PROFILE = {
  staleTime: 5 * 60_000,
  ...REMOUNT_REFRESH_QUERY_PROFILE,
};

// These are opt-in divergence profiles. They intentionally change cache
// retention or remount behavior and should not replace staleTime-only callsites
// during behavior-preserving cleanup.
export const SHORT_LIVED_QUERY_PROFILE = {
  staleTime: 60_000,
  gcTime: 5 * 60_000,
  refetchOnMount: true as const,
  refetchOnWindowFocus: false,
};

export const ADMIN_STATUS_QUERY_PROFILE = {
  ...FIVE_MINUTE_QUERY_PROFILE,
  gcTime: 10 * 60_000,
};

export const SESSION_STATIC_QUERY_PROFILE = {
  staleTime: Number.POSITIVE_INFINITY,
  ...REMOUNT_REFRESH_QUERY_PROFILE,
};

export const STATIC_QUERY_PROFILE = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  refetchOnMount: false as const,
  refetchOnWindowFocus: false,
};

export const QUERY_CLIENT_DEFAULT_OPTIONS = {
  queries: DEFAULT_QUERY_PROFILE,
};
