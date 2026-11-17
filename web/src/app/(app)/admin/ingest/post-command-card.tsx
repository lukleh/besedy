"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";
import {
  POST_INGEST_COMMAND_MAX_LENGTH,
  POST_INGEST_PLACEHOLDERS,
  postIngestCommandResponseSchema,
} from "@/lib/ingest/post-command";

const QUERY_KEY = ["admin-ingest-post-command"];
const PATH = "/api/admin/ingest/post-command";

export function PostCommandCard() {
  const t = useTranslations("admin.ingest.postCommand");
  const tCommon = useTranslations("common");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchJson(PATH, { schema: postIngestCommandResponseSchema }),
  });
  const saved = query.data?.command ?? "";
  const value = draft ?? saved;

  const saveMutation = useMutation({
    mutationFn: (command: string) =>
      fetchJson(PATH, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: command.trim() || null }),
        schema: postIngestCommandResponseSchema,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(QUERY_KEY, result);
      setDraft(null);
      toast({ title: result.command ? t("saved") : t("cleared") });
    },
    onError: (error: Error) => {
      toast({
        title: tCommon("error"),
        description: error instanceof ApiError ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  const dirty = value.trim() !== saved;

  return (
    <Card data-testid="ingest-post-command-card">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="ingest-post-command">{t("label")}</Label>
          {query.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : query.error ? (
            <p className="text-sm text-destructive">{t("loadError")}</p>
          ) : (
            <Input
              id="ingest-post-command"
              value={value}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={POST_INGEST_COMMAND_MAX_LENGTH}
              placeholder={t("placeholder")}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-xs"
              disabled={saveMutation.isPending}
              data-testid="ingest-post-command-input"
            />
          )}
          <p className="text-xs text-muted-foreground">
            {t("placeholders", {
              names: POST_INGEST_PLACEHOLDERS.map((name) => `{${name}}`).join(", "),
            })}
          </p>
          <p className="text-xs text-muted-foreground">{t("hostSwitch")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={() => saveMutation.mutate(value)}
            disabled={!dirty || saveMutation.isPending || query.isLoading || Boolean(query.error)}
            data-testid="ingest-post-command-save"
          >
            {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("save")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setDraft(null)}
            disabled={!dirty || saveMutation.isPending}
          >
            {tCommon("cancel")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
