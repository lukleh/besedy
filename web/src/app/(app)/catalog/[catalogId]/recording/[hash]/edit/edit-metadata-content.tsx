"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { MetadataEditor } from "@/components/metadata/metadata-editor";
import { SourceDataViewer } from "@/components/metadata/source-data-viewer";
import { DuplicatesViewer } from "@/components/metadata/duplicates-viewer";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import type { RecordingDetails } from "@/types/catalog";
import { useCatalogContext } from "@/hooks/use-catalog-context";
import { useRecordingEntry } from "@/hooks/use-recording-entry";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  AUTH_SENSITIVE_QUERY_OPTIONS,
  getStableAccessData,
  getStableAccessLoading,
  isAccessDeniedError,
} from "@/lib/query/auth-sensitive";

interface EditMetadataContentProps {
  catalogId: string;
  hash: string;
  skipCatalogValidation?: boolean;
}

export default function EditMetadataContent({
  catalogId,
  hash,
  skipCatalogValidation = false,
}: EditMetadataContentProps) {
  // Owns the interactive metadata editing workspace after the server page has
  // already established catalog and recording edit access.
  const t = useTranslations();
  const router = useRouter();
  const { groupKey, catalogNotFound, catalogValidationLoading } = useCatalogContext(catalogId, {
    skipCatalogValidation,
  });

  // Fetch single catalog entry with permissions
  const { data, cachedData, isLoading, isValidatingAccess, error } = useRecordingEntry({
    catalogId,
    hash,
    groupKey,
    enabled: !catalogNotFound && !catalogValidationLoading,
  });
  const resolvedData = data ?? (isValidatingAccess ? cachedData : undefined);

  // Fetch full recording details (source data + duplicates)
  const detailsQuery = useQuery<RecordingDetails>({
    queryKey: ["recording-details", hash, groupKey],
    queryFn: async () => {
      return fetchJson<RecordingDetails>(
        `/api/catalogs/${catalogId}/recordings/${hash}/details`
      );
    },
    enabled:
      !!hash &&
      !catalogNotFound &&
      !catalogValidationLoading &&
      !!resolvedData?.canEditMetadata,
    ...AUTH_SENSITIVE_QUERY_OPTIONS,
  });
  const details = getStableAccessData(detailsQuery);
  const detailsLoading = getStableAccessLoading(detailsQuery);
  const detailsAccessDenied = isAccessDeniedError(detailsQuery.error);

  const recording = resolvedData?.entry;
  const canEdit = resolvedData?.canEditMetadata ?? false;

  useEffect(() => {
    if (detailsAccessDenied || (data && !canEdit)) {
      router.replace(`/catalog/${catalogId}/recording/${hash}`);
    }
  }, [canEdit, catalogId, data, detailsAccessDenied, hash, router]);

  if (detailsAccessDenied || (data && !canEdit)) {
    return null;
  }

  const isPageLoading = catalogValidationLoading || (isLoading && !recording) || detailsLoading;

  if (isPageLoading) {
    return (
      <div className="w-full max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[400px] w-full rounded-lg" />
        <Skeleton className="h-[300px] w-full rounded-lg" />
      </div>
    );
  }

  if (catalogNotFound) {
    return (
      <div className="w-full max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Link
          href="/catalog"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("recording.backToCatalog")}
        </Link>
        <div className="text-center py-12">
          <h2 className="text-lg font-semibold">{t("catalog.invalidTitle")}</h2>
          <p className="text-sm text-muted-foreground mt-2">
            {t("catalog.invalidDescription", { id: catalogId })}
          </p>
        </div>
      </div>
    );
  }

  if (error || !recording) {
    return (
      <div className="w-full max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Link
          href={`/catalog/${catalogId}`}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("recording.backToCatalog")}
        </Link>
        <div className="text-center py-12">
          <h2 className="text-lg font-semibold">{t("recording.notFound")}</h2>
          <p className="text-sm text-muted-foreground mt-2">
            {t("recording.notFoundDescription")}
          </p>
        </div>
      </div>
    );
  }

  // Transform raw CSV data to frontend format
  const sourceMetadata = details?.sourceMetadata ?? null;
  const sourceArchived = details?.sourceArchived ?? null;
  const duplicates = details?.duplicates ?? [];

  return (
    <div className="w-full max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("metadata.editCurated")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {recording.title || recording.filename || hash.slice(0, 16)}
        </p>
      </div>

      {/* Section 1: Curated Metadata Editor (existing) */}
      <MetadataEditor
        hash={hash}
        groupId={catalogId}
        source={{
          title: recording.title,
          artist: recording.artist,
          album: recording.album?.name,
          date: recording.date,
        }}
      />

      <Separator />

      {/* Section 2: Source Recording Data (new - display only) */}
      <SourceDataViewer
        metadata={sourceMetadata}
        archived={sourceArchived}
      />

      {/* Section 3: Duplicates (new - display only) */}
      {duplicates.length > 0 && (
        <>
          <Separator />
          <DuplicatesViewer
            duplicates={duplicates}
            originalMetadata={sourceMetadata}
          />
        </>
      )}
    </div>
  );
}
