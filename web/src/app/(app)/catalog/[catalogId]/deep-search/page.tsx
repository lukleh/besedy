import { DeepSearchListClient } from "@/components/deep-search/deep-search-list-client";
import { requireDeepSearchPageAccess } from "./page-helpers";

interface DeepSearchPageProps {
  params: Promise<{ catalogId: string }>;
}

export default async function DeepSearchPage({ params }: DeepSearchPageProps) {
  const { catalogId } = await params;
  const { catalogLabel, canCreateJobs, deepSearchDefaultInstructions } =
    await requireDeepSearchPageAccess(catalogId);

  return (
    <div className="w-full max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
      <DeepSearchListClient
        catalogId={catalogId}
        catalogLabel={catalogLabel}
        canCreateJobs={canCreateJobs}
        deepSearchDefaultInstructions={deepSearchDefaultInstructions}
      />
    </div>
  );
}
