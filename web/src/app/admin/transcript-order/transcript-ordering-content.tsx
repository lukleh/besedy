"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { formatModelLabel } from "@/lib/transcript-labels";
import { fetchJson } from "@/lib/api/fetch-json";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface TranscriptBackendItem {
  backend: string;
  priority: number | null;
  discovered: boolean;
}

interface TranscriptBackendResponse {
  items: TranscriptBackendItem[];
}

const QUERY_KEY = ["admin-transcript-backends"];

export default function TranscriptOrderingContent() {
  const t = useTranslations("admin.transcripts");
  const tCommon = useTranslations("common");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [draftOverrides, setDraftOverrides] = useState<Record<string, string>>({});

  const { data, isLoading } = useQuery<TranscriptBackendResponse>({
    queryKey: QUERY_KEY,
    queryFn: () => fetchJson<TranscriptBackendResponse>("/api/admin/transcript-backends"),
  });

  const baselineDraft = useMemo(() => {
    if (!data) return {};
    const nextDraft: Record<string, string> = {};
    for (const item of data.items) {
      nextDraft[item.backend] = item.priority === null ? "" : String(item.priority);
    }
    return nextDraft;
  }, [data]);

  const draft = useMemo(
    () => ({
      ...baselineDraft,
      ...draftOverrides,
    }),
    [baselineDraft, draftOverrides],
  );

  const hasChanges = useMemo(
    () => Boolean(data && Object.keys(draftOverrides).length > 0),
    [data, draftOverrides],
  );

  const saveMutation = useMutation({
    mutationFn: async (updates: Array<{ backend: string; priority: number | null }>) => {
      return fetchJson("/api/admin/transcript-backends", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
    },
    onSuccess: async () => {
      setDraftOverrides({});
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast({ title: t("toasts.saved") });
    },
    onError: (error: Error) => {
      toast({
        title: tCommon("error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSave = () => {
    if (!data) return;

    const updates: Array<{ backend: string; priority: number | null }> = [];
    for (const item of data.items) {
      const raw = (draft[item.backend] ?? "").trim();
      if (raw === "") {
        updates.push({ backend: item.backend, priority: null });
        continue;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        toast({
          title: tCommon("error"),
          description: t("toasts.invalidPriority", { backend: item.backend }),
          variant: "destructive",
        });
        return;
      }
      updates.push({ backend: item.backend, priority: Math.trunc(parsed) });
    }

    saveMutation.mutate(updates);
  };

  const handleReset = async () => {
    setDraftOverrides({});
    await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-96 mt-2" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const items = data?.items ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t("description")}</p>
        <p className="text-xs text-muted-foreground mt-2">{t("hint")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={handleSave}
          disabled={!hasChanges || saveMutation.isPending}
        >
          {saveMutation.isPending ? t("saving") : t("save")}
        </Button>
        <Button
          variant="outline"
          onClick={handleReset}
          disabled={saveMutation.isPending}
        >
          {t("reset")}
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border bg-muted/50 p-6 text-sm text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("table.backend")}</TableHead>
                <TableHead className="w-40">{t("table.priority")}</TableHead>
                <TableHead className="w-32">{t("table.status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.backend}>
                  <TableCell>
                    <div className="font-medium">{formatModelLabel(item.backend)}</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {item.backend}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      inputMode="numeric"
                      value={draft[item.backend] ?? ""}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setDraftOverrides((prev) => {
                          const next = { ...prev };
                          const baseline = baselineDraft[item.backend] ?? "";
                          if (nextValue === baseline) {
                            delete next[item.backend];
                          } else {
                            next[item.backend] = nextValue;
                          }
                          return next;
                        });
                      }}
                      placeholder={t("table.unset")}
                    />
                  </TableCell>
                  <TableCell>
                    {item.discovered ? (
                      <Badge variant="secondary">{t("table.discovered")}</Badge>
                    ) : (
                      <Badge variant="outline">{t("table.missing")}</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
