"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/fetch-json";
import { AUTH_SENSITIVE_QUERY_PROFILE } from "@/lib/query/profiles";

// Permission-sensitive queries may still revalidate after remounts or explicit
// invalidation, but mounted UI should stay stable while that validation is in
// flight. We fail closed only after the fresh request actually confirms the
// user no longer has access.
export const AUTH_SENSITIVE_QUERY_OPTIONS = AUTH_SENSITIVE_QUERY_PROFILE;

type AccessSensitiveQueryState<TData> = Pick<
  UseQueryResult<TData>,
  "data" | "error" | "isFetching" | "isLoading"
>;

export function isAccessDeniedError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

function hasCachedAuthAccessError<TData>(
  query: AccessSensitiveQueryState<TData>
): boolean {
  // These auth-sensitive routes may use 404 to hide inaccessible resources,
  // so cached data must fail closed for that status as well.
  return query.data !== undefined && isAccessDeniedError(query.error);
}

export function isAwaitingFreshAccessData<TData>(
  query: AccessSensitiveQueryState<TData>
): boolean {
  return query.data !== undefined && query.isFetching;
}

export function getStableAccessData<TData>(
  query: AccessSensitiveQueryState<TData>
): TData | undefined {
  return hasCachedAuthAccessError(query) ? undefined : query.data;
}

export function getStableAccessLoading<TData>(
  query: AccessSensitiveQueryState<TData>
): boolean {
  return query.isLoading;
}

export function getFreshAccessData<TData>(
  query: AccessSensitiveQueryState<TData>
): TData | undefined {
  return isAwaitingFreshAccessData(query) || hasCachedAuthAccessError(query)
    ? undefined
    : query.data;
}

export function getFreshAccessLoading<TData>(
  query: AccessSensitiveQueryState<TData>
): boolean {
  return query.isLoading || isAwaitingFreshAccessData(query);
}
