import { notFound, redirect } from "next/navigation";
import RecordingContent from "./recording-content";
import { getRecordingCapability } from "@/lib/access/capabilities";
import { getSession } from "@/lib/auth/session";

interface RecordingPageProps {
  params: Promise<{ catalogId: string; hash: string }>;
}

export default async function RecordingPage({ params }: RecordingPageProps) {
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

  return (
    <RecordingContent
      params={{ catalogId, hash }}
      skipCatalogValidation
    />
  );
}
