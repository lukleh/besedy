import { notFound, redirect } from "next/navigation";
import { EventEditor } from "@/components/catalog/event-editor";
import { getSession } from "@/lib/auth/session";
import { getCatalogFeaturesForUser } from "@/lib/features/capabilities";

export default async function EventEditPage({
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
  if (!featureData.data.features.events.canEdit) {
    redirect(`/catalog/${catalogId}/event/${parsedEventId}?readOnly=events`);
  }

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <EventEditor catalogId={catalogId} eventId={parsedEventId} />
    </div>
  );
}
