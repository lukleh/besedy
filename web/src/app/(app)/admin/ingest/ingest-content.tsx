"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { useArchive } from "@/hooks/use-archive";
import { useLocations, useRecorders } from "@/hooks/use-metadata-enums";
import { z } from "zod";
import { EventCreationCandidateSchema } from "@/lib/catalog-events/create-conflict";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";
import { cn, formatBytes } from "@/lib/utils";
import {
  finalizeUploadResponseSchema,
  getAllowedIngestExtension,
  isActiveIntakeStatus,
  isRemovableIntakeStatus,
  recordingIntakeListSchema,
  type RecordingIntakeDto,
} from "@/lib/ingest/types";
import {
  finalizeUpload,
  uploadRecording,
  type UploadRecordingEvent,
} from "@/lib/ingest/upload-client";
import { IntakeStatus } from "./intake-status";
import { PostCommandCard } from "./post-command-card";

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

/** The place and date for the upload's event; null when both are empty. */
const eventCandidatesSchema = z.object({ candidates: z.array(EventCreationCandidateSchema) });

/** "new" for a separate new event, an event id, or "" when nothing is chosen. */
type EventChoice = { key: string; value: string };
const NO_EVENT_CHOICE: EventChoice = { key: "", value: "" };

function parseUploadEvent(
  locationId: string,
  date: string
): UploadRecordingEvent | null | "incomplete" {
  if (!locationId && !date) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const location = Number(locationId);
  if (!match || !Number.isInteger(location) || location <= 0) return "incomplete";
  return {
    locationId: location,
    dateYear: Number(match[1]),
    dateMonth: Number(match[2]),
    dateDay: Number(match[3]),
  };
}

function isFileDrag(event: { dataTransfer: DataTransfer | null }): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

export default function IngestContent() {
  const t = useTranslations("admin.ingest");
  const tCommon = useTranslations("common");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [removeTarget, setRemoveTarget] = useState<RecordingIntakeDto | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [locationId, setLocationId] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [recorderId, setRecorderId] = useState("");

  const { data: archive, isLoading: archiveLoading, error: archiveError } = useArchive();
  const catalogId = archive?.id ?? "";
  const { data: locations } = useLocations(catalogId || undefined);
  const { data: recorders } = useRecorders(catalogId || undefined);
  const uploadEvent = parseUploadEvent(locationId, eventDate);
  const [eventChoiceState, setEventChoiceState] = useState<EventChoice>(NO_EVENT_CHOICE);
  // A choice belongs to one place and date; changing either drops it.
  const eventKey = uploadEvent && uploadEvent !== "incomplete" ? `${locationId}|${eventDate}` : "";
  const eventChoice = eventChoiceState.key === eventKey ? eventChoiceState.value : "";
  const candidatesQuery = useQuery({
    queryKey: ["ingest-event-candidates", eventKey],
    queryFn: () => {
      const event = uploadEvent as UploadRecordingEvent;
      const params = new URLSearchParams({
        locationId: String(event.locationId),
        dateYear: String(event.dateYear),
        ...(event.dateMonth != null ? { dateMonth: String(event.dateMonth) } : {}),
        ...(event.dateDay != null ? { dateDay: String(event.dateDay) } : {}),
      });
      return fetchJson(`/api/admin/ingest/event-candidates?${params}`, {
        schema: eventCandidatesSchema,
      });
    },
    enabled: eventKey !== "",
  });
  const eventCandidates = eventKey ? (candidatesQuery.data?.candidates ?? []) : [];
  const needsEventChoice = eventCandidates.length > 0 && eventChoice === "";

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
    mutationFn: async ({
      items,
      event,
      recorder,
      choice,
    }: {
      items: UploadItem[];
      event: UploadRecordingEvent | null;
      recorder: number | null;
      choice: string;
    }) => {
      const results: RecordingIntakeDto[] = [];
      // One id for the whole upload: later files join the event the first one gets.
      const uploadBatchId = event ? crypto.randomUUID() : null;
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
            event,
            recorderId: recorder,
            uploadBatchId,
            targetEventId: choice && choice !== "new" ? Number(choice) : null,
            createDistinctEvent: choice === "new",
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
    onSuccess: (results, { items }) => {
      if (results.length > 0) {
        // The next upload is usually another talk; never carry its details over.
        setLocationId("");
        setEventDate("");
        setRecorderId("");
        setEventChoiceState(NO_EVENT_CHOICE);
      }
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

  // A file dropped outside the drop zone would otherwise make the browser
  // open it in this tab and lose the page. The zone's own handlers run first
  // and mark the events as handled.
  useEffect(() => {
    const blockStrayFileDrop = (event: globalThis.DragEvent) => {
      if (event.defaultPrevented || !isFileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", blockStrayFileDrop);
    window.addEventListener("drop", blockStrayFileDrop);
    return () => {
      window.removeEventListener("dragover", blockStrayFileDrop);
      window.removeEventListener("drop", blockStrayFileDrop);
    };
  }, []);

  const handleFilesSelected = (files: FileList | null) => {
    if (!files) return;
    selectFiles(Array.from(files));
  };

  const selectFiles = (files: File[]) => {
    const items: UploadItem[] = files.map((file, index) => ({
      key: `${Date.now()}-${index}-${file.name}`,
      file,
      phase: "pending",
      sentBytes: 0,
    }));
    setUploads(items);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (uploadMutation.isPending || !isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOver(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDragOver(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (uploadMutation.isPending || !isFileDrag(event)) return;
    event.preventDefault();
    setIsDragOver(false);
    // Unlike the picker, a drop ignores the input's `accept` filter, so apply
    // the upload API's extension rule here. Most folders fail it too, but one
    // named like a media file gets through and fails when it is uploaded.
    const accepted: File[] = [];
    const skipped: File[] = [];
    for (const file of Array.from(event.dataTransfer.files)) {
      (getAllowedIngestExtension(file.name) ? accepted : skipped).push(file);
    }
    if (skipped.length > 0) {
      toast({
        title: t("upload.skipped", { count: skipped.length }),
        description: skipped.map((file) => file.name).join(", "),
        variant: "destructive",
      });
    }
    if (accepted.length === 0) return;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    selectFiles(accepted);
  };

  const pendingUploads = useMemo(
    () => uploads.filter((item) => item.phase === "pending"),
    [uploads]
  );

  const handleUpload = () => {
    if (
      !catalogId ||
      pendingUploads.length === 0 ||
      uploadEvent === "incomplete" ||
      needsEventChoice
    ) {
      return;
    }
    uploadMutation.mutate({
      items: pendingUploads,
      event: uploadEvent,
      recorder: recorderId ? Number(recorderId) : null,
      choice: eventCandidates.length > 0 ? eventChoice : "",
    });
  };

  const handleReset = () => {
    setUploads([]);
    setLocationId("");
    setEventDate("");
    setRecorderId("");
    setEventChoiceState(NO_EVENT_CHOICE);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const intakes = intakesQuery.data?.intakes ?? [];
  // The last poll failed, or is waiting for the browser to come back online;
  // the list shown is the last one that loaded.
  const connectionLost = intakesQuery.isRefetchError || intakesQuery.isPaused;

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
              {archiveLoading ? (
                <Skeleton className="h-10 w-full" />
              ) : (
                <p className="py-2 text-sm" data-testid="ingest-archive">
                  {archive?.label || archive?.id || archiveError?.message || tCommon("error")}
                </p>
              )}
            </div>
            <div
              className={cn(
                "space-y-2 rounded-lg border-2 border-dashed p-3 transition-colors",
                isDragOver ? "border-primary bg-primary/5" : "border-muted-foreground/25"
              )}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              data-drag-over={isDragOver || undefined}
              data-testid="ingest-dropzone"
            >
              <Label htmlFor="ingest-files">{t("upload.files")}</Label>
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Upload className="h-3.5 w-3.5 shrink-0" />
                {t("upload.dropHint")}
              </p>
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

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="ingest-location">{t("upload.location")}</Label>
              <Select
                value={locationId || "none"}
                onValueChange={(value) => setLocationId(value === "none" ? "" : value)}
                disabled={uploadMutation.isPending}
              >
                <SelectTrigger id="ingest-location" data-testid="ingest-location">
                  <SelectValue placeholder={t("upload.locationPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{tCommon("none")}</SelectItem>
                  {locations?.map((location) => (
                    <SelectItem key={location.id} value={location.id.toString()}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ingest-date">{t("upload.date")}</Label>
              <Input
                id="ingest-date"
                type="date"
                value={eventDate}
                onChange={(event) => setEventDate(event.target.value)}
                disabled={uploadMutation.isPending}
                data-testid="ingest-date"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ingest-recorder">{t("upload.recorder")}</Label>
              <Select
                value={recorderId || "none"}
                onValueChange={(value) => setRecorderId(value === "none" ? "" : value)}
                disabled={uploadMutation.isPending}
              >
                <SelectTrigger id="ingest-recorder" data-testid="ingest-recorder">
                  <SelectValue placeholder={t("upload.recorderPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{tCommon("none")}</SelectItem>
                  {recorders?.map((recorder) => (
                    <SelectItem key={recorder.id} value={recorder.id.toString()}>
                      {recorder.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p
              className={cn(
                "text-xs md:col-span-3",
                uploadEvent === "incomplete" ? "text-destructive" : "text-muted-foreground"
              )}
              data-testid="ingest-event-hint"
            >
              {uploadEvent === "incomplete" ? t("upload.eventIncomplete") : t("upload.eventHint")}
            </p>
            {eventCandidates.length > 0 && (
              <div className="space-y-2 md:col-span-3" data-testid="ingest-event-choice">
                <Label htmlFor="ingest-event-choice">{t("upload.eventChoice")}</Label>
                <Select
                  value={eventChoice || undefined}
                  onValueChange={(value) => setEventChoiceState({ key: eventKey, value })}
                  disabled={uploadMutation.isPending}
                >
                  <SelectTrigger id="ingest-event-choice" data-testid="ingest-event-choice-select">
                    <SelectValue placeholder={t("upload.eventChoicePlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {eventCandidates.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id.toString()}>
                        {t("upload.eventChoiceExisting", {
                          title: candidate.title ?? `#${candidate.id}`,
                          count: candidate.recordingCount,
                        })}
                      </SelectItem>
                    ))}
                    <SelectItem value="new">{t("upload.eventChoiceNew")}</SelectItem>
                  </SelectContent>
                </Select>
                <p
                  className={cn(
                    "text-xs",
                    needsEventChoice ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  {t("upload.eventChoiceHint")}
                </p>
              </div>
            )}
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
                uploadMutation.isPending ||
                pendingUploads.length === 0 ||
                !catalogId ||
                uploadEvent === "incomplete" ||
                needsEventChoice
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
          {connectionLost && intakesQuery.data && (
            <p className="mb-3 text-sm text-destructive" data-testid="ingest-refresh-error">
              {t("jobs.refreshError")}
            </p>
          )}
          {intakesQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : intakesQuery.error && !intakesQuery.data ? (
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
                        {intake.locationName && intake.dateYear != null && (
                          <div className="text-xs text-muted-foreground" data-testid="ingest-intake-event">
                            {intake.locationName} ·{" "}
                            {[intake.dateDay, intake.dateMonth, intake.dateYear]
                              .filter((part) => part != null)
                              .join(". ")}
                          </div>
                        )}
                        {intake.recorderName && (
                          <div className="text-xs text-muted-foreground" data-testid="ingest-intake-recorder">
                            {t("jobs.recordedBy", { name: intake.recorderName })}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>{intake.catalogLabel || intake.catalogId}</TableCell>
                      <TableCell className="text-sm">
                        {intake.requestedBy?.name || intake.requestedBy?.email || "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {new Date(intake.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <IntakeStatus intake={intake} connectionLost={connectionLost} />
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
                          {intake.eventId != null && intake.status === "SUCCEEDED" && (
                            <Link
                              href={`/catalog/${intake.catalogId}/event/${intake.eventId}`}
                              className="block text-xs underline"
                              data-testid="ingest-event-link"
                            >
                              {t("jobs.event", { id: intake.eventId })}
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

      <PostCommandCard />

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
