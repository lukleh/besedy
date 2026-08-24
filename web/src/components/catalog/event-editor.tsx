"use client";

import { useCallback, useMemo, useState, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2, Star, StarOff, Pencil } from "lucide-react";
import { fetchJson } from "@/lib/api/fetch-json";
import { formatPartialDate } from "@/lib/date-format";
import { useToast } from "@/hooks/use-toast";
import { useReloadBlocker } from "@/contexts/reload-safety-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  UnassignedRecordingsTable,
  type UnassignedResponse,
} from "@/components/catalog/unassigned-recordings-table";

interface EventDetailProps {
  catalogId: string;
  eventId: number;
}

interface EventRecording {
  audioHash: string;
  isPrimary: boolean;
  sortOrder: number;
  dateYear: number | null;
  dateMonth: number | null;
  dateDay: number | null;
  location: { id: number; name: string } | null;
  recorder: { id: number; name: string } | null;
}

interface EventDetailResponse {
  id: number;
  workflowGroupId: string;
  title: string | null;
  location: { id: number; name: string } | null;
  dateYear: number;
  dateMonth: number | null;
  dateDay: number | null;
  sessionIndex: number;
  description: string | null;
  released: boolean;
  canManagePosters?: boolean;
  canManageSources?: boolean;
  recordings: EventRecording[];
}

interface LocationItem {
  id: number;
  name: string;
}

export function EventEditor({ catalogId, eventId }: EventDetailProps) {
  const locale = useLocale();
  const t = useTranslations("events.editor");
  const tRoot = useTranslations();
  const tCommon = useTranslations("events.common");
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editLocationId, setEditLocationId] = useState("");
  const [editDateYear, setEditDateYear] = useState("");
  const [editDateMonth, setEditDateMonth] = useState("");
  const [editDateDay, setEditDateDay] = useState("");
  const [editSessionIndex, setEditSessionIndex] = useState("");
  const [editDescription, setEditDescription] = useState("");

  const detailQueryKey = useMemo(
    () => ["catalog-event-detail", eventId] as const,
    [eventId]
  );

  const { data, isLoading, error } = useQuery<EventDetailResponse>({
    queryKey: detailQueryKey,
    queryFn: () =>
      fetchJson<EventDetailResponse>(`/api/catalogs/${catalogId}/events/${eventId}`),
  });

  const { data: unassigned } = useQuery<UnassignedResponse>({
    queryKey: ["catalog-event-unassigned", catalogId],
    queryFn: () => {
      const params = new URLSearchParams({
        group: catalogId,
        limit: "25",
      });
      return fetchJson<UnassignedResponse>(
        `/api/catalog-events/unassigned?${params.toString()}`
      );
    },
  });

  const { data: locations = [] } = useQuery<LocationItem[]>({
    queryKey: ["locations", catalogId],
    queryFn: () => fetchJson<LocationItem[]>(`/api/metadata/locations?group=${catalogId}`),
  });

  const refreshEvent = () => {
    queryClient.invalidateQueries({ queryKey: detailQueryKey });
    queryClient.invalidateQueries({ queryKey: ["catalog-events", catalogId] });
    queryClient.invalidateQueries({ queryKey: ["catalog-events-health", catalogId] });
    queryClient.invalidateQueries({ queryKey: ["catalog-event-unassigned", catalogId] });
  };

  const attachMutation = useMutation({
    mutationFn: async (audioHash: string) => {
      return fetchJson(`/api/catalogs/${catalogId}/events/${eventId}/recordings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioHashes: [audioHash] }),
      });
    },
    onSuccess: () => {
      refreshEvent();
      toast({ title: t("toastRecordingAttached") });
    },
    onError: (err: Error) => {
      toast({ title: t("toastAttachFailed"), description: err.message, variant: "destructive" });
    },
  });

  const detachMutation = useMutation({
    mutationFn: async (audioHash: string) => {
      return fetchJson(`/api/catalogs/${catalogId}/events/${eventId}/recordings/${audioHash}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      refreshEvent();
      toast({ title: t("toastRecordingDetached") });
    },
    onError: (err: Error) => {
      toast({ title: t("toastDetachFailed"), description: err.message, variant: "destructive" });
    },
  });

  const setPrimaryMutation = useMutation({
    mutationFn: async (audioHash: string) => {
      return fetchJson(
        `/api/catalogs/${catalogId}/events/${eventId}/recordings/${audioHash}/set-primary`,
        { method: "POST" }
      );
    },
    onSuccess: () => {
      refreshEvent();
      toast({ title: t("toastPrimaryUpdated") });
    },
    onError: (err: Error) => {
      toast({
        title: t("toastSetPrimaryFailed"),
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const toggleReleaseMutation = useMutation({
    mutationFn: async (released: boolean) => {
      return fetchJson(`/api/catalogs/${catalogId}/events/${eventId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ released }),
      });
    },
    onSuccess: () => {
      refreshEvent();
      toast({ title: t("toastEventStatusUpdated") });
    },
    onError: (err: Error) => {
      toast({ title: t("toastUpdateFailed"), description: err.message, variant: "destructive" });
    },
  });

  const updateMetadataMutation = useMutation({
    mutationFn: async (payload: {
      title: string | null;
      locationId: number;
      dateYear: number;
      dateMonth: number | null;
      dateDay: number | null;
      sessionIndex: number;
      description: string | null;
    }) => {
      return fetchJson(`/api/catalogs/${catalogId}/events/${eventId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      setEditOpen(false);
      refreshEvent();
      toast({ title: t("toastEventUpdated") });
    },
    onError: (err: Error) => {
      toast({ title: t("toastUpdateFailed"), description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      return fetchJson(`/api/catalogs/${catalogId}/events/${eventId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["catalog-events", catalogId] });
      queryClient.invalidateQueries({ queryKey: ["catalog-events-health", catalogId] });
      toast({ title: t("toastEventDeleted") });
      router.push(`/catalog/${catalogId}?tab=events`);
    },
    onError: (err: Error) => {
      toast({ title: t("toastDeleteFailed"), description: err.message, variant: "destructive" });
    },
  });

  const isBusy =
    attachMutation.isPending ||
    detachMutation.isPending ||
    setPrimaryMutation.isPending ||
    toggleReleaseMutation.isPending ||
    updateMetadataMutation.isPending ||
    deleteMutation.isPending;

  useReloadBlocker(
    {
      id: `event-editor:${catalogId}:${eventId}`,
      kind: "critical-mutation",
      blocksAutomatic: true,
      blocksManual: true,
    },
    isBusy
  );

  const hasUnsavedEdit = Boolean(
    editOpen &&
      data &&
      (editTitle !== (data.title ?? "") ||
        editLocationId !== (data.location?.id ? String(data.location.id) : "") ||
        editDateYear !== String(data.dateYear) ||
        editDateMonth !== (data.dateMonth ? String(data.dateMonth) : "") ||
        editDateDay !== (data.dateDay ? String(data.dateDay) : "") ||
        editSessionIndex !== String(data.sessionIndex) ||
        editDescription !== (data.description ?? ""))
  );

  useReloadBlocker(
    {
      id: `event-editor-draft:${catalogId}:${eventId}`,
      kind: "unsaved-changes",
      blocksAutomatic: true,
      blocksManual: true,
    },
    hasUnsavedEdit
  );

  const openEditDialog = () => {
    if (!data) return;
    setEditTitle(data.title ?? "");
    setEditLocationId(data.location?.id ? String(data.location.id) : "");
    setEditDateYear(String(data.dateYear));
    setEditDateMonth(data.dateMonth ? String(data.dateMonth) : "");
    setEditDateDay(data.dateDay ? String(data.dateDay) : "");
    setEditSessionIndex(String(data.sessionIndex));
    setEditDescription(data.description ?? "");
    setEditOpen(true);
  };

  const submitEdit = () => {
    const locationId = Number.parseInt(editLocationId, 10);
    const dateYear = Number.parseInt(editDateYear, 10);
    const dateMonth = editDateMonth ? Number.parseInt(editDateMonth, 10) : null;
    const dateDay = editDateDay ? Number.parseInt(editDateDay, 10) : null;
    const sessionIndex = Number.parseInt(editSessionIndex, 10);

    if (!Number.isFinite(locationId) || locationId <= 0) {
      toast({ title: tCommon("validationLocationRequired"), variant: "destructive" });
      return;
    }
    if (!Number.isFinite(dateYear) || dateYear < 1900) {
      toast({ title: tCommon("validationYearRequired"), variant: "destructive" });
      return;
    }
    if (dateDay !== null && dateMonth === null) {
      toast({
        title: tCommon("validationMonthRequired"),
        description: tCommon("validationMonthRequiredDescription"),
        variant: "destructive",
      });
      return;
    }
    if (!Number.isFinite(sessionIndex) || sessionIndex < 1) {
      toast({
        title: tCommon("validationSessionIndexRequired"),
        variant: "destructive",
      });
      return;
    }

    updateMetadataMutation.mutate({
      title: editTitle.trim() || null,
      locationId,
      dateYear,
      dateMonth,
      dateDay,
      sessionIndex,
      description: editDescription.trim() || null,
    });
  };

  const handleRowClick = (
    event: MouseEvent<HTMLTableRowElement>,
    audioHash: string
  ) => {
    const target = event.target as HTMLElement | null;
    if (
      target?.closest(
        "a, button, input, select, textarea, label, [role='button'], [role='link']"
      )
    ) {
      return;
    }
    router.push(`/catalog/${catalogId}/recording/${audioHash}`);
  };

  const formatDateForRow = useCallback(
    (dateYear: number | null, dateMonth: number | null, dateDay: number | null): string => {
      if (dateYear == null) return t("unknownDate");
      return formatPartialDate(dateYear, dateMonth, dateDay, locale) ?? String(dateYear);
    },
    [locale, t]
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-6">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="py-6 text-sm text-destructive">
        {t("loadError", {
          message: error instanceof Error ? error.message : t("unknownError"),
        })}
      </div>
    );
  }

  const primaryRecording = data.recordings.find((recording) => recording.isPrimary) ?? null;
  const canManagePosters = data.canManagePosters ?? false;
  const canManageSources = data.canManageSources ?? false;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            {data.title ?? t("eventFallbackTitle", { id: data.id })}
          </h1>
          <div className="text-sm text-muted-foreground">
            {data.location?.name ?? t("unknownLocation")} •{" "}
            {formatPartialDate(data.dateYear, data.dateMonth, data.dateDay, locale)}
          </div>
          {data.description && (
            <p className="mt-2 text-sm text-muted-foreground">{data.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {data.released ? (
            <Badge>{t("released")}</Badge>
          ) : (
            <Badge variant="secondary">{t("unreleased")}</Badge>
          )}
          {data.sessionIndex > 1 ? (
            <Badge variant="outline">{t("sessionLabel", { index: data.sessionIndex })}</Badge>
          ) : null}
          {canManagePosters && (
            <Button asChild variant="outline">
              <Link href={`/catalog/${catalogId}/event/${eventId}/poster`}>
                {tRoot("recording.editPoster")}
              </Link>
            </Button>
          )}
          {canManageSources && (
            <Button asChild variant="outline">
              <Link href={`/catalog/${catalogId}/event/${eventId}/sources`}>
                {tRoot("recording.sourcesTitle")}
              </Link>
            </Button>
          )}
          <Button variant="outline" onClick={openEditDialog} disabled={isBusy}>
            <Pencil className="h-4 w-4 mr-1" />
            {t("edit")}
          </Button>
          <Button
            variant="outline"
            onClick={() => toggleReleaseMutation.mutate(!data.released)}
            disabled={isBusy}
          >
            {data.released ? t("unrelease") : t("release")}
          </Button>
          <Button
            variant="destructive"
            onClick={() => deleteMutation.mutate()}
            disabled={isBusy}
          >
            <Trash2 className="h-4 w-4 mr-1" />
            {t("delete")}
          </Button>
        </div>
      </div>

      <div className="rounded-md border p-4">
        <h2 className="text-base font-medium">{t("primaryRecording")}</h2>
        {primaryRecording ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{formatDateForRow(primaryRecording.dateYear, primaryRecording.dateMonth, primaryRecording.dateDay)}</span>
            <span className="text-muted-foreground">{primaryRecording.location?.name ?? t("unknownLocation")}</span>
            <span className="text-muted-foreground">{primaryRecording.recorder?.name ?? t("unknownRecorder")}</span>
            <span className="font-mono text-xs">{primaryRecording.audioHash}</span>
            <Button asChild size="sm" variant="outline">
              <Link href={`/catalog/${catalogId}/recording/${primaryRecording.audioHash}`}>
                {t("openRecording")}
              </Link>
            </Button>
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            {t("noPrimaryRecording")}
          </p>
        )}
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columnPrimary")}</TableHead>
              <TableHead>{t("columnDate")}</TableHead>
              <TableHead>{t("columnLocation")}</TableHead>
              <TableHead>{t("columnRecorder")}</TableHead>
              <TableHead>{t("columnHash")}</TableHead>
              <TableHead className="text-right">{t("columnActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.recordings.map((recording) => (
              <TableRow
                key={recording.audioHash}
                className="cursor-pointer"
                onClick={(event) => handleRowClick(event, recording.audioHash)}
              >
                <TableCell>
                  {recording.isPrimary ? (
                    <Star className="h-4 w-4 fill-current text-amber-500" />
                  ) : (
                    <StarOff className="h-4 w-4 text-muted-foreground" />
                  )}
                </TableCell>
                <TableCell>{formatDateForRow(recording.dateYear, recording.dateMonth, recording.dateDay)}</TableCell>
                <TableCell>{recording.location?.name ?? t("unknownLocation")}</TableCell>
                <TableCell>{recording.recorder?.name ?? t("unknownRecorder")}</TableCell>
                <TableCell>
                  <Link
                    href={`/catalog/${catalogId}/recording/${recording.audioHash}`}
                    className="font-mono text-xs underline-offset-2 hover:underline"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {recording.audioHash}
                  </Link>
                </TableCell>
                <TableCell className="text-right space-x-2">
                  {!recording.isPrimary && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(event) => {
                        event.stopPropagation();
                        setPrimaryMutation.mutate(recording.audioHash);
                      }}
                      disabled={isBusy}
                    >
                      {t("setPrimary")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={(event) => {
                      event.stopPropagation();
                      detachMutation.mutate(recording.audioHash);
                    }}
                    disabled={isBusy}
                  >
                    {t("detach")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {data.recordings.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-sm text-muted-foreground">
                  {t("noRecordingsAttached")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="rounded-md border p-4 space-y-3">
        <h2 className="text-base font-medium">{t("attachUnassignedTitle")}</h2>
        <UnassignedRecordingsTable
          catalogId={catalogId}
          entries={unassigned?.entries ?? []}
          actionLabel={t("attach")}
          containerClassName="max-h-64"
          emptyLabel={t("noMatchingUnassigned")}
          isBusy={isBusy}
          isActionPending={(entry) =>
            attachMutation.isPending && attachMutation.variables === entry.audioHash
          }
          onAction={(entry) => attachMutation.mutate(entry.audioHash)}
        />
        <div className="text-xs text-muted-foreground">
          {t("unassignedCount", {
            count: unassigned?.pagination.total ?? 0,
          })}
        </div>
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("editDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("editDialogDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="event-title">{t("fieldTitle")}</Label>
              <Input
                id="event-title"
                value={editTitle}
                onChange={(event) => setEditTitle(event.target.value)}
                placeholder={t("fieldTitlePlaceholder")}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="event-session-index">{t("fieldSessionIndex")}</Label>
              <Input
                id="event-session-index"
                value={editSessionIndex}
                onChange={(event) => setEditSessionIndex(event.target.value)}
                placeholder={t("fieldSessionIndexPlaceholder")}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="event-location">{t("fieldLocation")}</Label>
              <select
                id="event-location"
                value={editLocationId}
                onChange={(event) => setEditLocationId(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">{t("selectLocation")}</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-2">
                <Label htmlFor="event-year">{t("fieldYear")}</Label>
                <Input
                  id="event-year"
                  value={editDateYear}
                  onChange={(event) => setEditDateYear(event.target.value)}
                  placeholder={t("fieldYearPlaceholder")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="event-month">{t("fieldMonth")}</Label>
                <Input
                  id="event-month"
                  value={editDateMonth}
                  onChange={(event) => setEditDateMonth(event.target.value)}
                  placeholder={t("fieldMonthPlaceholder")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="event-day">{t("fieldDay")}</Label>
                <Input
                  id="event-day"
                  value={editDateDay}
                  onChange={(event) => setEditDateDay(event.target.value)}
                  placeholder={t("fieldDayPlaceholder")}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="event-description">{t("fieldDescription")}</Label>
              <Textarea
                id="event-description"
                value={editDescription}
                onChange={(event) => setEditDescription(event.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={isBusy}>
              {t("cancel")}
            </Button>
            <Button onClick={submitEdit} disabled={isBusy}>
              {t("saveChanges")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
