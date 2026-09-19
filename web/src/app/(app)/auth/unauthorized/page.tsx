"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { UserX, ArrowLeft, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { openSupportEmail } from "@/lib/support-email";

function UnauthorizedContent() {
  const t = useTranslations("auth");
  const searchParams = useSearchParams();

  // Extract email only from allowlist rejection format: "not_authorized:email@example.com"
  // This guards against displaying bogus emails from other error types like
  // "OAuthCallbackError: invalid_state" which would otherwise show "invalid_state"
  const errorMessage = searchParams.get("error") || searchParams.get("error_description") || "";
  const attemptedEmail = errorMessage.startsWith("not_authorized:")
    ? errorMessage.slice("not_authorized:".length)
    : null;

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-blue-100">
          <UserX className="h-6 w-6 text-blue-600" />
        </div>
        <CardTitle>{t("unauthorized.title")}</CardTitle>
        <CardDescription>
          {t("unauthorized.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {attemptedEmail && (
          <p className="text-center text-sm font-medium">
            {t("unauthorized.attemptedEmail", { email: attemptedEmail })}
          </p>
        )}
        <p className="text-center text-sm text-muted-foreground">
          {t("unauthorized.message")}
        </p>
        <p className="text-center text-sm text-muted-foreground">
          {t("unauthorized.contact")}
        </p>
        <div className="flex flex-col sm:flex-row gap-2 justify-center">
          <Button variant="outline" asChild>
            <Link href="/auth/signin">
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("backToSignIn")}
            </Link>
          </Button>
          <Button onClick={openSupportEmail}>
            <Mail className="mr-2 h-4 w-4" />
            {t("contactSupport")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function UnauthorizedSkeleton() {
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <Skeleton className="mx-auto mb-4 h-12 w-12 rounded-full" />
        <Skeleton className="mx-auto h-6 w-48" />
        <Skeleton className="mx-auto mt-2 h-4 w-64" />
      </CardHeader>
      <CardContent className="space-y-4">
        <Skeleton className="mx-auto h-4 w-full" />
        <Skeleton className="mx-auto h-10 w-32" />
      </CardContent>
    </Card>
  );
}

export default function UnauthorizedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Suspense fallback={<UnauthorizedSkeleton />}>
        <UnauthorizedContent />
      </Suspense>
    </div>
  );
}
