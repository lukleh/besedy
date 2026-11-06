"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildCorrectionPagePath } from "@/lib/api/recording-urls";

interface CorrectionLinkProps {
  catalogId: string;
  hash: string;
}

export function CorrectionLink({ catalogId, hash }: CorrectionLinkProps) {
  const t = useTranslations("correction");

  return (
    <Button asChild variant="outline" size="sm" className="gap-2">
      <Link href={buildCorrectionPagePath(catalogId, hash)}>
        <SquarePen className="h-4 w-4" />
        {t("openSurface")}
      </Link>
    </Button>
  );
}
