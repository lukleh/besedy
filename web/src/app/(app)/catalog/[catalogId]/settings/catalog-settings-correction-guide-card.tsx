"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { fetchJson } from "@/lib/api/fetch-json";

interface CorrectionGuideResponse {
  guide: {
    revisionId: string | null;
    body: string;
    authorId: string | null;
    updatedAt: string | null;
    isDefault: boolean;
  };
  canEdit: boolean;
}

interface CatalogSettingsCorrectionGuideCardProps {
  catalogId: string;
}

/**
 * The convention correctors share, as catalog data rather than product copy.
 *
 * Revisions are append-only and take effect immediately; an edit never
 * invalidates a decision, because people agreed about words rather than about
 * a document.
 */
export function CatalogSettingsCorrectionGuideCard({
  catalogId,
}: CatalogSettingsCorrectionGuideCardProps) {
  const t = useTranslations("correction");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);

  const guideQuery = useQuery<CorrectionGuideResponse>({
    queryKey: ["correction-guide", catalogId],
    queryFn: async () =>
      fetchJson<CorrectionGuideResponse>(
        `/api/catalogs/${catalogId}/correction-guide`
      ),
  });

  const save = useMutation({
    mutationFn: async (body: string) =>
      fetchJson(`/api/catalogs/${catalogId}/correction-guide`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }),
    onSuccess: async () => {
      // Drop the draft so the field tracks the saved revision again.
      setDraft(null);
      await queryClient.invalidateQueries({
        queryKey: ["correction-guide", catalogId],
      });
      toast({ description: t("guideSaved") });
    },
    onError: (error) =>
      toast({
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      }),
  });

  // The stored guide until somebody types; the draft from then on.
  const body = draft ?? guideQuery.data?.guide.body ?? "";
  const unchanged = body === guideQuery.data?.guide.body;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("guideTitle")}</CardTitle>
        <CardDescription>{t("guideDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {guideQuery.data?.guide.isDefault && (
          <p className="text-sm text-muted-foreground">{t("guideIsDefault")}</p>
        )}
        <Textarea
          value={body}
          onChange={(event) => setDraft(event.target.value)}
          rows={16}
          className="font-mono text-sm"
          disabled={guideQuery.isLoading || save.isPending}
        />
        <Button
          type="button"
          className="gap-2"
          disabled={unchanged || !body.trim() || save.isPending}
          onClick={() => save.mutate(body)}
        >
          {save.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {t("guideSave")}
        </Button>
      </CardContent>
    </Card>
  );
}
