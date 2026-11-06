import { notFound, redirect } from "next/navigation";
import { getRecordingCapability } from "@/lib/access/capabilities";
import { getSession } from "@/lib/auth/session";
import { CorrectionWorkspace } from "@/components/correction/correction-workspace";
import prisma from "@/lib/db";
import {
  catalogEventRecordingVisibilityWhere,
  resolveReadableEventIds,
} from "@/lib/catalog-events/read-service";

interface CorrectionPageProps {
  params: Promise<{ catalogId: string; hash: string }>;
}

export default async function CorrectionPage({ params }: CorrectionPageProps) {
  const { catalogId, hash } = await params;

  const session = await getSession();
  if (!session?.user?.id) {
    redirect("/auth/signin");
  }

  const capability = await getRecordingCapability(catalogId, hash, session.user.id);
  if (
    !capability.catalogExists ||
    !capability.hasAccess ||
    !capability.canAccessRecording ||
    !capability.canCorrectTranscripts
  ) {
    notFound();
  }

  const readableEventIds = await resolveReadableEventIds(catalogId, capability.catalogGrant);
  const assignment = await prisma.catalogEventRecording.findFirst({
    where: {
      workflowGroupId: catalogId,
      audioHash: hash,
      ...catalogEventRecordingVisibilityWhere(readableEventIds),
    },
    select: { eventId: true },
  });

  return (
    <CorrectionWorkspace
      catalogId={catalogId}
      hash={hash}
      userId={session.user.id}
      canPublish={capability.canPublishTranscript}
      eventId={assignment?.eventId ?? null}
    />
  );
}
