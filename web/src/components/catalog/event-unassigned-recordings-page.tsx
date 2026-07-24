"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2 } from "lucide-react";
import { fetchJson } from "@/lib/api/fetch-json";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { CatalogPagination } from "@/components/catalog/catalog-list/components/pagination";
import { type PaginationInfo } from "@/components/catalog/catalog-list/types";
import {
  UnassignedRecordingsTable,
  type UnassignedEntry,
  type UnassignedResponse,
} from "./unassigned-recordings-table";

const PAGE_SIZE = 50;

interface CreateEventFromRecordingResponse {
  eventId: number;
  audioHash: string;
  title: string;
}

interface EventUnassignedRecordingsPageProps {
  catalogId: string;
}

function toPaginationInfo(
  pagination: UnassignedResponse["pagination"]
): PaginationInfo {
  return {
    page: pagination.page,
    limit: pagination.limit,
    totalPages: pagination.totalPages,
    hasPrevPage: pagination.page > 1,
    hasNextPage: pagination.page < pagination.totalPages,
  };
}

function canCreateEventFromEntry(entry: UnassignedEntry): boolean {
  return entry.locationId !== null && entry.dateYear !== null;
}

export function EventUnassignedRecordingsPage({
  catalogId,
}: EventUnassignedRecordingsPageProps) {
  const t = useTranslations("events.unassignedPage");
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(1);

  const queryKey = useMemo(
    () => ["catalog-event-unassigned-page", catalogId, page] as const,
    [catalogId, page]
  );

  const { data, isLoading, error } = useQuery<UnassignedResponse>({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams({
        group: catalogId,
        page: String(page),
        limit: String(PAGE_SIZE),
      });
      return fetchJson<UnassignedResponse>(
        `/api/catalog-events/unassigned?${params.toString()}`
      );
    },
  });

  const createMutation = useMutation({
    mutationFn: async (entry: UnassignedEntry) => {
      return fetchJson<CreateEventFromRecordingResponse>(
        "/api/catalog-events/from-recording",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workflowGroupId: catalogId,
            audioHash: entry.audioHash,
          }),
        }
      );
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["catalog-events", catalogId] }),
        queryClient.invalidateQueries({ queryKey: ["catalog-events-health", catalogId] }),
        queryClient.invalidateQueries({ queryKey: ["catalog-event-unassigned", catalogId] }),
        queryClient.invalidateQueries({
          queryKey: ["catalog-event-unassigned-page", catalogId],
        }),
      ]);
      router.push(`/catalog/${catalogId}/event/${result.eventId}/edit`);
    },
    onError: (error: Error) => {
      toast({
        title: t("toastCreateFailed"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-6 text-sm text-destructive">
        {t("loadError", { message: error.message })}
      </div>
    );
  }

  const pagination = data?.pagination;
  const paginationInfo = pagination ? toPaginationInfo(pagination) : null;

  function handleCreateFromEntry(entry: UnassignedEntry) {
    if (!canCreateEventFromEntry(entry)) {
      toast({
        title: t("toastCreateFailed"),
        description: t("missingMetadataHint"),
        variant: "destructive",
      });
      return;
    }

    createMutation.mutate(entry);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/catalog/${catalogId}?tab=events`}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("backToEvents")}
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">{t("description")}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("metadataNotice")}
            </p>
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          {t("count", { count: pagination?.total ?? 0 })}
        </div>
      </div>

      <UnassignedRecordingsTable
        catalogId={catalogId}
        entries={data?.entries ?? []}
        actionLabel={t("createFrom")}
        emptyLabel={t("empty")}
        getRecordingHref={(entry) => {
          const params = new URLSearchParams({
            backTo: `/catalog/${catalogId}/events/unassigned`,
          });
          return `/catalog/${catalogId}/recording/${entry.audioHash}?${params.toString()}`;
        }}
        isBusy={createMutation.isPending}
        isActionPending={(entry) =>
          createMutation.isPending &&
          createMutation.variables?.audioHash === entry.audioHash
        }
        getActionTitle={(entry) =>
          canCreateEventFromEntry(entry) ? undefined : t("missingMetadataHint")
        }
        onAction={handleCreateFromEntry}
      />
      {paginationInfo ? (
        <CatalogPagination
          pagination={paginationInfo}
          onPageChange={setPage}
        />
      ) : null}
    </div>
  );
}
