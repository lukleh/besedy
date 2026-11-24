"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { buildCorrectionAdminOverviewPath } from "@/lib/api/recording-urls";

interface CatalogSettingsCorrectionsCardProps {
  catalogId: string;
}

/** Leads to the overview of who is correcting what. */
export function CatalogSettingsCorrectionsCard({ catalogId }: CatalogSettingsCorrectionsCardProps) {
  const t = useTranslations("catalogSettings.corrections");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" asChild>
          <Link href={buildCorrectionAdminOverviewPath(catalogId)}>{t("open")}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
