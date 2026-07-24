"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2 } from "lucide-react";
import { getAuthCompletionStatus } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

const SESSION_RECOVERY_ATTEMPTS = 5;
const SESSION_RECOVERY_INTERVAL_MS = 300;

type AuthCompleteClientProps = {
  callbackUrl: string;
  error: string | null;
  errorDescription: string | null;
  state: string | null;
};

function mapAuthErrorMessage(
  error: string | null,
  errorDescription: string | null,
  state: string | null,
  t: ReturnType<typeof useTranslations>
): string | null {
  const rawError = error || errorDescription;
  if (!rawError) {
    return state === "state_not_found" ? t("errors.oauthCallback") : null;
  }
  if (rawError === "OAuthAccountNotLinked") {
    return t("errors.accountLinked");
  }
  if (rawError === "AccessDenied") {
    return t("errors.accessDenied");
  }
  if (rawError.startsWith("OAuthCallbackError")) {
    return t("errors.oauthCallback");
  }
  return rawError;
}

export default function AuthCompleteClient({
  callbackUrl,
  error,
  errorDescription,
  state,
}: AuthCompleteClientProps) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [attemptNonce, setAttemptNonce] = useState(0);
  const [isRecovering, setIsRecovering] = useState(true);
  const [recoveryFailed, setRecoveryFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let resolveDelay: (() => void) | null = null;

    const waitForNextAttempt = () =>
      new Promise<void>((resolve) => {
        resolveDelay = () => {
          resolveDelay = null;
          resolve();
        };

        timeoutId = setTimeout(() => {
          timeoutId = null;
          resolveDelay?.();
        }, SESSION_RECOVERY_INTERVAL_MS);
      });

    const recoverSession = async () => {
      setIsRecovering(true);
      setRecoveryFailed(false);

      for (let attempt = 0; attempt < SESSION_RECOVERY_ATTEMPTS && !cancelled; attempt += 1) {
        try {
          const authenticated = await getAuthCompletionStatus({
            signal: abortController.signal,
          });
          if (cancelled || abortController.signal.aborted) {
            return;
          }

          if (authenticated) {
            router.replace(callbackUrl);
            return;
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }
          // Best effort only - transient failures should not block retry UI.
        }

        if (cancelled || attempt === SESSION_RECOVERY_ATTEMPTS - 1) {
          break;
        }

        await waitForNextAttempt();
      }

      if (!cancelled) {
        setIsRecovering(false);
        setRecoveryFailed(true);
      }
    };

    void recoverSession();

    return () => {
      cancelled = true;
      abortController.abort();
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      resolveDelay?.();
    };
  }, [attemptNonce, callbackUrl, router]);

  const errorMessage = mapAuthErrorMessage(error, errorDescription, state, t);
  const signInHref = `/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`;

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">{t("complete.title")}</CardTitle>
        <CardDescription>{t("complete.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {errorMessage && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        {isRecovering ? (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{t("complete.checking")}</span>
          </div>
        ) : null}

        {recoveryFailed ? (
          <>
            <p className="text-center text-sm text-muted-foreground">
              {t("complete.failed")}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
              <Button onClick={() => setAttemptNonce((value) => value + 1)}>
                {t("complete.retry")}
              </Button>
              <Button variant="outline" asChild>
                <Link href={signInHref}>{t("backToSignIn")}</Link>
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
