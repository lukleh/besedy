type ClientErrorReport = {
  message: string;
  stack?: string;
  digest?: string;
  source?: string;
  url?: string;
  userAgent?: string;
  context?: Record<string, unknown>;
};

/**
 * Benign browser warnings that should not be reported.
 * These are not real application errors.
 */
const IGNORED_ERROR_PATTERNS = [
  // ResizeObserver warning - happens when observer callbacks take too long.
  // Common with Radix UI components (Dialog, Select, ScrollArea).
  // See: https://github.com/WICG/resize-observer/issues/38
  "ResizeObserver loop",
];

function shouldIgnoreError(message: string): boolean {
  return IGNORED_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

export function reportClientError(report: ClientErrorReport) {
  if (typeof window === "undefined") {
    return;
  }

  // Skip benign browser warnings
  if (shouldIgnoreError(report.message)) {
    return;
  }

  const payload: ClientErrorReport = {
    ...report,
    url: report.url ?? window.location.href,
    userAgent: report.userAgent ?? navigator.userAgent,
  };

  fetch("/api/csp-report/client-error", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {
    // Silently fail if error reporting fails.
  });
}
