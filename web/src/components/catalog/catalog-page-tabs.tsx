"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { CatalogList } from "@/components/catalog/catalog-list";
import { EventList } from "@/components/catalog/event-list";
import { CatalogTabs } from "@/components/catalog/catalog-tabs";
import { Loader2 } from "lucide-react";
import { useCatalogFeatures } from "@/hooks/use-catalog-features";
import { type CatalogTab, useCatalogTab } from "@/hooks/use-catalog-tab";

interface CatalogPageTabsProps {
  catalogId: string;
}

export function CatalogPageTabs({ catalogId }: CatalogPageTabsProps) {
  const t = useTranslations("events.list");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: featureData, isPending } = useCatalogFeatures(catalogId);
  const canViewEvents = featureData?.features.events.canView ?? false;
  const canEditEvents = featureData?.features.events.canEdit ?? false;
  const showTabs = featureData?.features.events.showTabs ?? false;
  const showAllColumns = featureData?.features.events.showAllColumns ?? false;
  const showReleaseState = featureData?.features.events.showReleaseState ?? false;
  const canUseRagSearch = featureData?.features.events.canUseRagSearch ?? false;
  const canViewDeepSearch = featureData?.features.deepSearch?.canView ?? false;
  const { activeTab, setActiveTab } = useCatalogTab(catalogId, showTabs);
  const tabFromUrl = searchParams.get("tab");
  const initialTabFromUrl: CatalogTab | null =
    tabFromUrl === "events" || tabFromUrl === "recordings" ? tabFromUrl : null;

  useEffect(() => {
    if (!showTabs) return;
    if (!initialTabFromUrl) return;
    if (activeTab !== initialTabFromUrl) {
      setActiveTab(initialTabFromUrl);
    }
  }, [activeTab, initialTabFromUrl, setActiveTab, showTabs]);

  if (isPending) {
    return (
      <div className="flex items-center gap-2 py-6 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    );
  }

  const visibleTab: CatalogTab = !canViewEvents
    ? "recordings"
    : showTabs
      ? (initialTabFromUrl ?? activeTab)
      : "events";

  function handleTabChange(nextTab: CatalogTab) {
    setActiveTab(nextTab);

    const currentPath = pathname ?? `/catalog/${catalogId}`;
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set("tab", nextTab);
    const nextQuery = nextParams.toString();
    const nextUrl = nextQuery ? `${currentPath}?${nextQuery}` : currentPath;
    router.replace(nextUrl, { scroll: false });
  }

  const deepSearchHref = canViewDeepSearch
    ? `/catalog/${catalogId}/deep-search`
    : undefined;

  if (!canViewEvents) {
    return <CatalogList catalogId={catalogId} deepSearchHref={deepSearchHref} />;
  }

  return (
    <>
      {showTabs ? (
        <CatalogTabs activeTab={visibleTab} onChange={handleTabChange} />
      ) : null}
      {visibleTab === "recordings" ? (
        <CatalogList catalogId={catalogId} deepSearchHref={deepSearchHref} />
      ) : (
        <EventList
          catalogId={catalogId}
          canEdit={canEditEvents}
          showAllColumns={showAllColumns}
          showReleaseState={showReleaseState}
          canUseRagSearch={canUseRagSearch}
          deepSearchHref={deepSearchHref}
        />
      )}
    </>
  );
}
