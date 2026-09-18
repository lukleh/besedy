"use client";

import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface CatalogSettingsTranscriptExportsCardProps {
  onDownload: (mode: "zip" | "txt") => void;
}

export function CatalogSettingsTranscriptExportsCard({
  onDownload,
}: CatalogSettingsTranscriptExportsCardProps) {
  const t = useTranslations("catalogSettings");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("transcriptExports.title")}</CardTitle>
        <CardDescription>{t("transcriptExports.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onDownload("zip")}
          >
            <Download className="mr-2 h-4 w-4" />
            {t("buttons.downloadTxtZip")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onDownload("txt")}
          >
            <Download className="mr-2 h-4 w-4" />
            {t("buttons.downloadTxtMerged")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
