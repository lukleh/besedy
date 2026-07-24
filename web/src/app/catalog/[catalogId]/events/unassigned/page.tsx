import { notFound, redirect } from "next/navigation";
import { EventUnassignedRecordingsPage } from "@/components/catalog/event-unassigned-recordings-page";
import { getSession } from "@/lib/auth/session";
import { getCatalogFeaturesForUser } from "@/lib/features/capabilities";

export default async function CatalogEventUnassignedPage({
  params,
}: {
  params: Promise<{ catalogId: string }>;
}) {
  const { catalogId } = await params;

  const session = await getSession();
  if (!session?.user?.id) {
    redirect("/auth/signin");
  }

  const featureData = await getCatalogFeaturesForUser(catalogId, session.user.id);
  if (!featureData.catalogExists) {
    notFound();
  }
  if (!featureData.data.features.events.canView) {
    redirect(`/catalog/${catalogId}`);
  }
  if (!featureData.data.features.events.canEdit) {
    redirect(`/catalog/${catalogId}`);
  }

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <EventUnassignedRecordingsPage catalogId={catalogId} />
    </div>
  );
}
