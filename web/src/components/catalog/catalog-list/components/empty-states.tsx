"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertCircle, FileAudio, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CatalogNotFoundStateProps {
  catalogId: string | undefined;
}

export function CatalogNotFoundState({ catalogId }: CatalogNotFoundStateProps) {
  const t = useTranslations("catalog");
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <AlertCircle className="h-12 w-12 text-muted-foreground mb-4" />
      <h2 className="text-lg font-semibold">{t("invalidTitle")}</h2>
      <p className="text-sm text-muted-foreground mt-2">
        {t("invalidDescription", { id: catalogId ?? "" })}
      </p>
      <p className="text-sm text-muted-foreground mt-1">
        {t("errorDescription")}{" "}
        <Link href="/admin/catalogs" className="text-primary underline hover:text-primary/80">
          {t("configureGroups")}
        </Link>.
      </p>
    </div>
  );
}

interface CatalogErrorStateProps {
  error: Error | null;
}

export function CatalogErrorState({ error }: CatalogErrorStateProps) {
  const t = useTranslations("catalog");
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <AlertCircle className="h-12 w-12 text-muted-foreground mb-4" />
      <h2 className="text-lg font-semibold">{t("errorTitle")}</h2>
      <p className="text-sm text-muted-foreground mt-2">
        {error instanceof Error ? error.message : t("noResultsDescription")}
      </p>
      <p className="text-sm text-muted-foreground mt-1">
        {t("errorDescription")}{" "}
        <Link href="/admin/catalogs" className="text-primary underline hover:text-primary/80">
          {t("configureGroups")}
        </Link>.
      </p>
    </div>
  );
}

export function CatalogEmptyState() {
  const t = useTranslations("catalog");
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <FileAudio className="h-12 w-12 text-muted-foreground mb-4" />
      <h2 className="text-lg font-semibold">{t("emptyTitle")}</h2>
      <p className="text-sm text-muted-foreground mt-2">
        {t("emptyDescription")}{" "}
        <Link href="/admin/catalogs" className="text-primary underline hover:text-primary/80">
          {t("configureGroups")}
        </Link>.
      </p>
    </div>
  );
}

interface NoMatchStateProps {
  onClearFilters: () => void;
  className?: string;
}

export function NoMatchState({ onClearFilters, className }: NoMatchStateProps) {
  const t = useTranslations("catalog");
  return (
    <div className={className}>
      <Search className="h-8 w-8 text-muted-foreground" />
      <p className="text-muted-foreground">{t("noMatch")}</p>
      <Button variant="link" onClick={onClearFilters} className="h-auto p-0">
        {t("clearFilters")}
      </Button>
    </div>
  );
}
