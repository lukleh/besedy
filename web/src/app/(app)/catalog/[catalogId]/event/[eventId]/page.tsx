import { notFound, redirect } from "next/navigation";
import { EventDetail } from "@/components/catalog/event-detail";
import { getSession } from "@/lib/auth/session";
import { getCatalogFeaturesForUser } from "@/lib/features/capabilities";

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ catalogId: string; eventId: string }>;
}) {
  const { catalogId, eventId } = await params;
  const parsedEventId = Number.parseInt(eventId, 10);
  if (!Number.isFinite(parsedEventId) || parsedEventId <= 0) {
    notFound();
  }

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

  return (
    <EventDetail
      catalogId={catalogId}
      eventId={parsedEventId}
      canEdit={featureData.data.features.events.canEdit}
      showAllColumns={featureData.data.features.events.showAllColumns}
      showReleaseState={featureData.data.features.events.showReleaseState}
    />
  );
}
