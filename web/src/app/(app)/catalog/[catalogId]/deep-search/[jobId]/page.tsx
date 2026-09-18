import { notFound } from "next/navigation";
import { z } from "zod";
import { DeepSearchDetailClient } from "@/components/deep-search/deep-search-detail-client";
import { requireDeepSearchPageAccess } from "../page-helpers";

const JobIdSchema = z.string().uuid();

interface DeepSearchJobPageProps {
  params: Promise<{ catalogId: string; jobId: string }>;
}

export default async function DeepSearchJobPage({
  params,
}: DeepSearchJobPageProps) {
  const { catalogId, jobId } = await params;
  if (!JobIdSchema.safeParse(jobId).success) {
    notFound();
  }
  const { catalogLabel, canCreateJobs, deepSearchDefaultInstructions } =
    await requireDeepSearchPageAccess(catalogId);

  return (
    <div className="w-full max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
      <DeepSearchDetailClient
        catalogId={catalogId}
        catalogLabel={catalogLabel}
        jobId={jobId}
        canCreateJobs={canCreateJobs}
        deepSearchDefaultInstructions={deepSearchDefaultInstructions}
      />
    </div>
  );
}
