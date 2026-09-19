"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResponsiveSelect,
  ResponsiveSelectContent,
  ResponsiveSelectItem,
  ResponsiveSelectTrigger,
  ResponsiveSelectValue,
} from "@/components/ui/responsive-select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useCatalogs } from "@/hooks/use-catalogs";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";
import { formatBytes } from "@/lib/utils";
import {
  finalizeUploadResponseSchema,
  isActiveIntakeStatus,
  isRemovableIntakeStatus,
  recordingIntakeListSchema,
  type RecordingIntakeDto,
  type RecordingIntakeStatus,
} from "@/lib/ingest/types";
import { finalizeUpload, uploadRecording } from "@/lib/ingest/upload-client";

const INTAKES_QUERY_KEY = ["admin-ingest-intakes"];
const ACTIVE_POLL_INTERVAL_MS = 5000;

type UploadPhase = "pending" | "uploading" | "done" | "error";

interface UploadItem {
  key: string;
  file: File;
  phase: UploadPhase;
  sentBytes: number;
  error?: string;
}

function statusVariant(
  status: RecordingIntakeStatus
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "SUCCEEDED":
      return "default";
    case "FAILED":
    case "REJECTED":
      return "destructive";
    case "CANCELLED":
    case "REMOVED":
      return "outline";
    default:
      return "secondary";
  }
}

export default function IngestContent() {
  const t = useTranslations("admin.ingest");
  const tCommon = useTranslations("common");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [chosenCatalogId, setChosenCatalogId] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [removeTarget, setRemoveTarget] = useState<RecordingIntakeDto | null>(null);

  const { data: catalogs, isLoading: catalogsLoading } = useCatalogs();

  const catalogId = useMemo(() => {
    if (chosenCatalogId) return chosenCatalogId;
    if (!catalogs?.length) return "";
    return (catalogs.find((catalog) => catalog.isDefault) ?? catalogs[0]).id;
  }, [chosenCatalogId, catalogs]);

  const intakesQuery = useQuery({
    queryKey: INTAKES_QUERY_KEY,
    queryFn: () =>
      fetchJson("/api/admin/ingest?limit=50", { schema: recordingIntakeListSchema }),
    refetchInterval: (query) => {
      const intakes = query.state.data?.intakes ?? [];
      return intakes.some((intake) => isActiveIntakeStatus(intake.status))
        ? ACTIVE_POLL_INTERVAL_MS
        : false;
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async (items: UploadItem[]) => {
      const results: RecordingIntakeDto[] = [];
      for (const item of items) {
        setUploads((current) =>
          current.map((entry) =>
            entry.key === item.key ? { ...entry, phase: "uploading" } : entry
          )
        );
        try {
          const intake = await uploadRecording({
            catalogId,
            file: item.file,
            onProgress: (sentBytes) =>
              setUploads((current) =>
                current.map((entry) =>
                  entry.key === item.key ? { ...entry, sentBytes } : entry
                )
              ),
          });
          results.push(intake);
          setUploads((current) =>
            current.map((entry) =>
              entry.key === item.key
                ? { ...entry, phase: "done", sentBytes: item.file.size }
                : entry
            )
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : tCommon("error");
          setUploads((current) =>
            current.map((entry) =>
              entry.key === item.key ? { ...entry, phase: "error", error: message } : entry
            )
          );
        }
      }
      return results;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: INTAKES_QUERY_KEY }),
    onSuccess: (results, items) => {
      if (results.length === items.length) {
        toast({ title: t("toasts.queued", { count: results.length }) });
      } else {
        toast({
          title: t("toasts.partial", { done: results.length, total: items.length }),
          variant: "destructive",
        });
      }
    },
  });

  const retrySubmitMutation = useMutation({
    mutationFn: (intakeId: string) => finalizeUpload(intakeId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: INTAKES_QUERY_KEY });
      toast({ title: t("toasts.queued", { count: 1 }) });
    },
    onError: (error: Error) => {
      toast({
        title: tCommon("error"),
        description: error instanceof ApiError ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (intakeId: string) =>
      fetchJson(`/api/admin/ingest/${encodeURIComponent(intakeId)}/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        schema: finalizeUploadResponseSchema,
      }),
    onSuccess: async (result) => {
      setRemoveTarget(null);
      await queryClient.invalidateQueries({ queryKey: INTAKES_QUERY_KEY });
      toast({
        title:
          result.intake.status === "REMOVED"
            ? t("toasts.removed")
            : t("toasts.removalQueued"),
      });
    },
    onError: (error: Error) => {
      toast({
        title: tCommon("error"),
        description: error instanceof ApiError ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  const handleFilesSelected = (files: FileList | null) => {
    if (!files) return;
    const items: UploadItem[] = Array.from(files).map((file, index) => ({
      key: `${Date.now()}-${index}-${file.name}`,
      file,
      phase: "pending",
      sentBytes: 0,
    }));
    setUploads(items);
  };

  const pendingUploads = useMemo(
    () => uploads.filter((item) => item.phase === "pending"),
    [uploads]
  );

  const handleUpload = () => {
    if (!catalogId || pendingUploads.length === 0) return;
    uploadMutation.mutate(pendingUploads);
  };

  const handleReset = () => {
    setUploads([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const intakes = intakesQuery.data?.intakes ?? [];
  const selectedCatalog = catalogs?.find((catalog) => catalog.id === catalogId);

  return (
    <div className="space-y-6" data-testid="admin-ingest-page">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <Card data-testid="ingest-upload-card">
        <CardHeader>
          <CardTitle>{t("upload.title")}</CardTitle>
          <CardDescription>{t("upload.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("upload.catalog")}</Label>
              {catalogsLoading ? (
                <Skeleton className="h-10 w-full" />
              ) : (
                <ResponsiveSelect
                  value={catalogId}
                  onValueChange={setChosenCatalogId}
                  disabled={uploadMutation.isPending || !catalogs?.length}
                >
                  <ResponsiveSelectTrigger className="w-full" aria-label={t("upload.catalog")}>
                    <ResponsiveSelectValue
                      placeholder={t("upload.selectCatalog")}
                      displayValue={
                        selectedCatalog
                          ? selectedCatalog.label || selectedCatalog.id
                          : undefined
                      }
                    />
                  </ResponsiveSelectTrigger>
                  <ResponsiveSelectContent title={t("upload.catalog")}>
                    {(catalogs ?? []).map((catalog) => (
                      <ResponsiveSelectItem key={catalog.id} value={catalog.id}>
                        {catalog.label || catalog.id}
                      </ResponsiveSelectItem>
                    ))}
                  </ResponsiveSelectContent>
                </ResponsiveSelect>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="ingest-files">{t("upload.files")}</Label>
              <Input
                id="ingest-files"
                ref={fileInputRef}
                type="file"
                multiple
                accept="audio/*,video/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.opus,.webm,.mp4,.mkv"
                disabled={uploadMutation.isPending}
                onChange={(event) => handleFilesSelected(event.target.files)}
                data-testid="ingest-file-input"
              />
            </div>
          </div>

          {uploads.length > 0 && (
            <ul className="space-y-2 text-sm" data-testid="ingest-upload-list">
              {uploads.map((item) => {
                const percent =
                  item.file.size > 0
                    ? Math.round((item.sentBytes / item.file.size) * 100)
                    : 100;
                return (
                  <li key={item.key} className="rounded-lg border px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{item.file.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatBytes(item.file.size) ?? ""}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      {item.phase === "uploading" && (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      )}
                      <span>{t(`upload.phase.${item.phase}`, { percent })}</span>
                      {item.error && <span className="text-destructive">{item.error}</span>}
                    </div>
                    {item.phase === "uploading" && (
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-muted">
                        <div
                          className="h-full bg-primary transition-all"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={handleUpload}
              disabled={
                uploadMutation.isPending || pendingUploads.length === 0 || !catalogId
              }
              data-testid="ingest-upload-button"
            >
              {uploadMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              {t("upload.submit", { count: pendingUploads.length })}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={handleReset}
              disabled={uploadMutation.isPending || uploads.length === 0}
            >
              {tCommon("cancel")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <CardTitle>{t("jobs.title")}</CardTitle>
            <CardDescription>{t("jobs.description")}</CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => intakesQuery.refetch()}
            disabled={intakesQuery.isFetching}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${intakesQuery.isFetching ? "animate-spin" : ""}`}
            />
            {t("jobs.refresh")}
          </Button>
        </CardHeader>
        <CardContent>
          {intakesQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : intakesQuery.error ? (
            <p className="text-sm text-destructive">{t("jobs.loadError")}</p>
          ) : intakes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("jobs.empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("jobs.columns.file")}</TableHead>
                    <TableHead>{t("jobs.columns.catalog")}</TableHead>
                    <TableHead>{t("jobs.columns.requestedBy")}</TableHead>
                    <TableHead>{t("jobs.columns.created")}</TableHead>
                    <TableHead>{t("jobs.columns.status")}</TableHead>
                    <TableHead>{t("jobs.columns.result")}</TableHead>
                    <TableHead className="text-right">{t("jobs.columns.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {intakes.map((intake) => (
                    <TableRow key={intake.id} data-testid="ingest-intake-row">
                      <TableCell>
                        <div className="max-w-[18rem] truncate font-medium" title={intake.originalFilename}>
                          {intake.originalFilename}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatBytes(intake.sizeBytes) ?? ""}
                        </div>
                      </TableCell>
                      <TableCell>{intake.catalogLabel || intake.catalogId}</TableCell>
                      <TableCell className="text-sm">
                        {intake.requestedBy?.name || intake.requestedBy?.email || "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {new Date(intake.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(intake.status)}>
                          {t(`status.${intake.status}`)}
                        </Badge>
                        {intake.prefectStateName &&
                          isActiveIntakeStatus(intake.status) && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              {intake.prefectStateName}
                            </div>
                          )}
                      </TableCell>
                      <TableCell className="text-sm">
                        <div className="space-y-1">
                          {intake.audioHash &&
                            (intake.status === "SUCCEEDED" || intake.status === "REJECTED") && (
                              <Link
                                href={`/catalog/${intake.catalogId}/recording/${intake.audioHash}`}
                                className="font-mono text-xs underline"
                              >
                                {intake.audioHash.slice(0, 12)}…
                              </Link>
                            )}
                          {intake.errorCode && (
                            <div className="text-destructive">
                              <div>
                                {t.has(`errors.${intake.errorCode}`)
                                  ? t(`errors.${intake.errorCode}`)
                                  : intake.errorCode}
                              </div>
                              {intake.errorMessage && intake.status !== "REJECTED" && (
                                <div
                                  className="max-w-[24rem] truncate text-xs text-muted-foreground"
                                  title={intake.errorMessage}
                                >
                                  {intake.errorMessage}
                                </div>
                              )}
                            </div>
                          )}
                          {intake.status === "UPLOADING" &&
                            intake.receivedBytes === intake.sizeBytes && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => retrySubmitMutation.mutate(intake.id)}
                                disabled={retrySubmitMutation.isPending}
                              >
                                {t("jobs.retrySubmit")}
                              </Button>
                            )}
                          {!intake.errorCode &&
                            !intake.audioHash &&
                            !(intake.status === "UPLOADING" && intake.receivedBytes === intake.sizeBytes) && (
                              <span className="text-muted-foreground">—</span>
                            )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {isRemovableIntakeStatus(intake.status) && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            onClick={() => setRemoveTarget(intake)}
                            disabled={removeMutation.isPending}
                            aria-label={t("jobs.remove")}
                            data-testid="ingest-remove-button"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("remove.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget?.status === "SUCCEEDED" ||
              (removeTarget?.status === "FAILED" && removeTarget.audioHash)
                ? t("remove.descriptionCatalog", { file: removeTarget?.originalFilename ?? "" })
                : t("remove.descriptionFiles", { file: removeTarget?.originalFilename ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeMutation.isPending}>
              {tCommon("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (removeTarget) removeMutation.mutate(removeTarget.id);
              }}
              disabled={removeMutation.isPending}
              data-testid="ingest-remove-confirm"
            >
              {removeMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("remove.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
