import { notFound, redirect } from "next/navigation";
import EditMetadataContent from "./edit-metadata-content";
import { getRecordingCapability } from "@/lib/access/capabilities";
import { getSession } from "@/lib/auth/session";

interface EditPageProps {
  params: Promise<{ catalogId: string; hash: string }>;
}

export default async function EditMetadataPage({ params }: EditPageProps) {
  const { catalogId, hash } = await params;

  const session = await getSession();
  if (!session?.user?.id) {
    redirect("/auth/signin");
  }

  const capability = await getRecordingCapability(catalogId, hash, session.user.id);
  if (
    !capability.catalogExists ||
    !capability.hasAccess ||
    !capability.canAccessRecording
  ) {
    notFound();
  }
  if (!capability.canEditRecording) {
    redirect(`/catalog/${catalogId}/recording/${hash}`);
  }

  return (
    <EditMetadataContent
      catalogId={catalogId}
      hash={hash}
      skipCatalogValidation
    />
  );
}
