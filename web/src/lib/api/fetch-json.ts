"use client";

import type { ZodError, ZodType } from "zod";
import { createClientLogger } from "@/lib/log/client";
import { notifyWebVersionObserver } from "@/lib/service-worker/runtime";

type SchemaValidationIssue = ZodError["issues"][number];

const logger = createClientLogger("fetchJson");

export class ApiError extends Error {
  status: number;
  payload?: unknown;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

/**
 * The server returned a 2xx response but its payload did not match the
 * schema the caller asked fetchJson to validate against. Extends ApiError
 * so existing `instanceof ApiError` checks still match, but carries
 * `status = 0` as a sentinel so callers filtering on HTTP status ranges
 * (`>= 500`, `=== 401`, ...) do not misclassify a contract mismatch as a
 * server error.
 */
export class SchemaValidationError extends ApiError {
  issues: readonly SchemaValidationIssue[];

  constructor(
    message: string,
    payload: unknown,
    issues: readonly SchemaValidationIssue[]
  ) {
    super(message, 0, payload);
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

interface ApiErrorPayload {
  error?: string;
}

function redirectToSignIn(): void {
  if (typeof window === "undefined") return;

  const { pathname, search } = window.location;
  // Avoid callback recursion on auth pages.
  if (pathname.startsWith("/auth/")) {
    window.location.assign("/auth/signin");
    return;
  }

  const callbackUrl = `${pathname}${search}`;
  const params = new URLSearchParams({ callbackUrl });
  window.location.assign(`/auth/signin?${params.toString()}`);
}

export interface FetchJsonOptions extends RequestInit {
  skipAuthCheck?: boolean;
  schema?: ZodType<unknown>;
}

function formatRequestTarget(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if ("url" in input && typeof input.url === "string") return input.url;
  return String(input);
}

function hasExpectedEmptyBody(method: string, response: Response): boolean {
  return (
    method === "HEAD" ||
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304
  );
}

export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: FetchJsonOptions & { schema?: ZodType<T> }
): Promise<T> {
  const {
    skipAuthCheck = false,
    schema,
    ...requestInitOverrides
  } = init ?? {};
  const method = requestInitOverrides.method?.toUpperCase() ?? "GET";
  const requestInit: RequestInit = {
    ...requestInitOverrides,
    // Intentional temporary safeguard: bypass browser/HTTP caching for JSON reads.
    // Re-enable only after the broader client caching story is redesigned and verified.
    cache:
      requestInitOverrides.cache ??
      (method === "GET" || method === "HEAD" ? "no-store" : undefined),
  };

  const response = await fetch(input, requestInit);

  try {
    const webVersion =
      response.headers?.get?.("X-Web-Version") ??
      response.headers?.get?.("X-App-Commit");
    if (webVersion) {
      notifyWebVersionObserver(webVersion);
    }
  } catch (error) {
    // Observing the deployed web version must never break a real request.
    logger.warn("Failed to notify web-version observer", {
      input: formatRequestTarget(input),
      error,
    });
  }

  const contentType = response.headers?.get?.("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  let payload: unknown = null;
  if (hasExpectedEmptyBody(method, response)) {
    payload = null;
  } else if (isJson) {
    payload = await response.json().catch((error) => {
      logger.warn("Failed to parse JSON response", {
        input: formatRequestTarget(input),
        error,
      });
      return null;
    });
  } else if (!contentType && typeof response.json === "function") {
    // Some tests/mock responses omit headers; attempt JSON parse anyway.
    payload = await response.json().catch((error) => {
      logger.warn("Failed to parse JSON response with missing content-type", {
        input: formatRequestTarget(input),
        error,
      });
      return null;
    });
  }

  if (!response.ok) {
    if (!skipAuthCheck && response.status === 401) {
      redirectToSignIn();
    }
    const message =
      (payload as ApiErrorPayload | null)?.error ||
      response.statusText ||
      "Request failed";
    throw new ApiError(message, response.status, payload);
  }

  if (schema) {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      logger.warn("Response schema validation failed", {
        input: formatRequestTarget(input),
        issues: parsed.error.issues,
      });
      throw new SchemaValidationError(
        "Invalid response payload",
        payload,
        parsed.error.issues
      );
    }

    return parsed.data as T;
  }

  return payload as T;
}
