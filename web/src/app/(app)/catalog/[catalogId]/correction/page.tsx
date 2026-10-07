import { notFound } from "next/navigation";
import { requireCatalogPageAccess } from "@/lib/access/catalog-page-access";
import { CorrectionOverviewPage } from "@/components/correction/correction-overview";

interface CorrectionOverviewRouteProps {
  params: Promise<{ catalogId: string }>;
}

export default async function CorrectionOverviewRoute({ params }: CorrectionOverviewRouteProps) {
  const { catalogId } = await params;
  const { capability } = await requireCatalogPageAccess(catalogId);

  // The overview is for people who correct or publish; the reader panel on a
  // recording is what everybody else sees of the work.
  if (!capability.canCorrectTranscripts && !capability.canPublishTranscript) {
    notFound();
  }

  return <CorrectionOverviewPage catalogId={catalogId} />;
}
