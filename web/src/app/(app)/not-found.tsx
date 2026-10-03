import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { NOT_FOUND_PAGE_ATTRIBUTE } from "@/lib/pwa/last-route";

export default async function NotFound() {
  const t = await getTranslations("errors");

  return (
    <EmptyState
      {...{ [NOT_FOUND_PAGE_ATTRIBUTE]: "" }}
      icon={SearchX}
      title={t("notFound")}
      description={t("notFoundDescription")}
      actions={
        <Button asChild>
          <Link href="/catalog">
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("goToCatalogs")}
          </Link>
        </Button>
      }
    />
  );
}
