import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { CatalogPageTabs } from "@/components/catalog/catalog-page-tabs";
import { ErrorBoundary } from "@/components/error-boundary";
import { Loader2 } from "lucide-react";
import { requireCatalogPageAccess } from "@/lib/access/catalog-page-access";
import { getCatalogFeaturesForUser } from "@/lib/features/capabilities";

// Suspense fallback must be synchronous for immediate rendering.
// Hardcoded English is acceptable for brief loading states.
function CatalogLoading() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Loader2 className="h-12 w-12 text-muted-foreground mb-4 animate-spin" />
      <h2 className="text-lg font-semibold">Loading catalog...</h2>
      <p className="text-sm text-muted-foreground mt-2">
        Preparing your recordings
      </p>
    </div>
  );
}

export default async function CatalogPage({
  params,
  searchParams,
}: {
  params: Promise<{ catalogId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { catalogId } = await params;
  const resolvedSearchParams = await searchParams;
  const tabParam = resolvedSearchParams?.tab;
  const requestedTab = Array.isArray(tabParam) ? tabParam[0] : tabParam;
  const { userId } = await requireCatalogPageAccess(catalogId, {
    unauthorizedRedirect: "/catalog",
  });

  if (requestedTab === "events" || requestedTab === "recordings") {
    const featureData = await getCatalogFeaturesForUser(catalogId, userId);
    if (!featureData.catalogExists) {
      notFound();
    }

    if (requestedTab === "events" && !featureData.data.features.events.canView) {
      redirect(`/catalog/${catalogId}`);
    }

    if (requestedTab === "recordings" && !featureData.data.features.events.showTabs) {
      redirect(`/catalog/${catalogId}`);
    }
  }

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <ErrorBoundary>
        <Suspense fallback={<CatalogLoading />}>
          <CatalogPageTabs catalogId={catalogId} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
