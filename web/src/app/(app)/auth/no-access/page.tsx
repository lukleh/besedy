"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { FolderLock, ArrowLeft, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { openSupportEmail } from "@/lib/support-email";

export default function NoAccessPage() {
  const t = useTranslations("auth");

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
            <FolderLock className="h-6 w-6 text-amber-600" />
          </div>
          <CardTitle>{t("noAccess.title")}</CardTitle>
          <CardDescription>
            {t("noAccess.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-center text-sm text-muted-foreground">
            {t("noAccess.message")}
          </p>
          <p className="text-center text-sm text-muted-foreground">
            {t("noAccess.contact")}
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
    </div>
  );
}
