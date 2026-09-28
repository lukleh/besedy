import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

export default async function NotFound() {
  const t = await getTranslations("errors");

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 pb-6 sm:pt-6">
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <SearchX className="h-12 w-12 text-muted-foreground mb-4" />
        <h1 className="text-lg font-semibold">{t("notFound")}</h1>
        <p className="text-sm text-muted-foreground mt-2 max-w-md">{t("notFoundDescription")}</p>
        <Button asChild className="mt-6">
          <Link href="/catalog">
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("goToCatalogs")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
