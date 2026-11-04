import { notFound, redirect } from "next/navigation";
import { getRecordingCapability } from "@/lib/access/capabilities";
import { getSession } from "@/lib/auth/session";
import { CorrectionWorkspace } from "@/components/correction/correction-workspace";
import { buildCorrectionPagePath } from "@/lib/api/recording-urls";
import { sanitizePostAuthCallbackPath } from "@/lib/auth/oauth-routing";
import { BACK_TO_PARAM, resolveBackToPath, withBackTo } from "@/lib/navigation/back-to";

type SearchParams = Record<string, string | string[] | undefined>;

function getFirstSearchParamValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

interface CorrectionPageProps {
  params: Promise<{ catalogId: string; hash: string }>;
  searchParams?: Promise<SearchParams>;
}

export default async function CorrectionPage({ params, searchParams }: CorrectionPageProps) {
  const { catalogId, hash } = await params;

  const session = await getSession();
  if (!session?.user?.id) {
    const query = await searchParams;
    const path = buildCorrectionPagePath(catalogId, hash, getFirstSearchParamValue(query?.segment));
    const backTo = resolveBackToPath(getFirstSearchParamValue(query?.[BACK_TO_PARAM]));
    const callbackUrl = sanitizePostAuthCallbackPath(backTo ? withBackTo(path, backTo) : path);
    redirect(`/auth/signin?${new URLSearchParams({ callbackUrl })}`);
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

  return (
    <CorrectionWorkspace
      catalogId={catalogId}
      hash={hash}
      userId={session.user.id}
      canPublish={capability.canPublishTranscript}
    />
  );
}
