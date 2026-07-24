"use client";

import { useEffect } from "react";
import { NextIntlClientProvider } from "next-intl";

import { Providers } from "@/components/providers";
import { SessionProvider } from "@/contexts/session-context";
import { reportClientError } from "@/lib/client-error-reporting";

/**
 * Session data passed from server to client for hydration
 */
interface SessionData {
  user: {
    id: string;
    email: string;
    name: string | null;
    image: string | null;
    emailVerified: boolean;
  };
  session: {
    id: string;
    token: string;
    expiresAt: Date;
  };
}

type ErrorDetails = {
  message: string;
  stack?: string;
  name?: string;
};

const normalizeUnknownError = (value: unknown): ErrorDetails => {
  if (value instanceof Error) {
    return {
      message: value.message || "Unknown error",
      stack: value.stack,
      name: value.name,
    };
  }

  if (typeof value === "string") {
    return { message: value };
  }

  if (value && typeof value === "object") {
    const maybeMessage = "message" in value ? (value as { message?: unknown }).message : undefined;
    const maybeStack = "stack" in value ? (value as { stack?: unknown }).stack : undefined;
    const maybeName = "name" in value ? (value as { name?: unknown }).name : undefined;

    return {
      message: maybeMessage ? String(maybeMessage) : "Unknown error",
      stack: typeof maybeStack === "string" ? maybeStack : undefined,
      name: maybeName ? String(maybeName) : undefined,
    };
  }

  return { message: String(value ?? "Unknown error") };
};

function ClientErrorReporter() {
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      const details = normalizeUnknownError(event.error ?? event.message);

      reportClientError({
        message: details.message,
        stack: details.stack,
        source: "window.onerror",
        context: {
          name: details.name,
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        },
      });
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const details = normalizeUnknownError(event.reason);

      reportClientError({
        message: details.message,
        stack: details.stack,
        source: "window.unhandledrejection",
        context: {
          name: details.name,
          reasonType: typeof event.reason,
        },
      });
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  return null;
}

type AppProvidersProps = {
  children: React.ReactNode;
  locale: string;
  messages: Record<string, unknown>;
  timeZone: string;
  initialSession: SessionData | null;
  nonce?: string;
};

export function AppProviders({
  children,
  locale,
  messages,
  timeZone,
  initialSession,
  nonce,
}: AppProvidersProps) {
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone={timeZone}>
      <ClientErrorReporter />
      <SessionProvider initialSession={initialSession}>
        <Providers nonce={nonce}>{children}</Providers>
      </SessionProvider>
    </NextIntlClientProvider>
  );
}
