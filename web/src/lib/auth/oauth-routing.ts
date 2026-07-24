const DEFAULT_POST_AUTH_PATH = "/catalog";
const DISALLOWED_POST_AUTH_NAMESPACES = ["/auth", "/api"];
const SANITIZER_BASE_URL = "http://besedy.local";

type AuthCompletePathOptions = {
  error?: string | null;
  errorDescription?: string | null;
  state?: string | null;
};

function normalizeAppRelativePath(path: string | null | undefined): string | null {
  const hasControlChars = path ? /[\u0000-\u001f\u007f]/.test(path) : false;
  if (
    !path ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    hasControlChars
  ) {
    return null;
  }

  try {
    const normalized = new URL(path, SANITIZER_BASE_URL);
    if (normalized.origin !== SANITIZER_BASE_URL) {
      return null;
    }

    return `${normalized.pathname}${normalized.search}${normalized.hash}`;
  } catch {
    return null;
  }
}

export function sanitizeAppRelativePath(path: string | null | undefined): string {
  return normalizeAppRelativePath(path) ?? DEFAULT_POST_AUTH_PATH;
}

export function sanitizePostAuthCallbackPath(path: string | null | undefined): string {
  const normalized = normalizeAppRelativePath(path);
  if (!normalized) {
    return DEFAULT_POST_AUTH_PATH;
  }

  const normalizedPathname = new URL(normalized, SANITIZER_BASE_URL).pathname;
  if (
    DISALLOWED_POST_AUTH_NAMESPACES.some(
      (namespace) =>
        normalizedPathname === namespace || normalizedPathname.startsWith(`${namespace}/`)
    )
  ) {
    return DEFAULT_POST_AUTH_PATH;
  }
  return normalized;
}

export function buildAuthCompletePath(
  callbackPath: string | null | undefined,
  options?: AuthCompletePathOptions
): string {
  const params = new URLSearchParams({
    callbackUrl: sanitizePostAuthCallbackPath(callbackPath),
  });

  if (options?.error) {
    params.set("error", options.error);
  }
  if (options?.errorDescription) {
    params.set("error_description", options.errorDescription);
  }
  if (options?.state) {
    params.set("state", options.state);
  }

  return `/auth/complete?${params.toString()}`;
}

export function getAllowlistRejectionParam(
  error: string | null | undefined,
  errorDescription: string | null | undefined
): string | null {
  if (error?.startsWith("not_authorized:")) {
    return error;
  }
  if (errorDescription?.startsWith("not_authorized:")) {
    return errorDescription;
  }
  return null;
}

export function hasOAuthCallbackResidue(options: AuthCompletePathOptions): boolean {
  return Boolean(options.error || options.errorDescription || options.state);
}
