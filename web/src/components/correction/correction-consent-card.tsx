"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { fetchJson } from "@/lib/api/fetch-json";

const CONSENT_URL = "/api/me/correction-consent";

const consentResponseSchema = z.object({
  consent: z.object({
    accepted: z.boolean(),
    version: z.string(),
    text: z.string(),
  }),
});

type ConsentResponse = z.infer<typeof consentResponseSchema>;

export const CONTRIBUTOR_CONSENT_QUERY_KEY = ["correction-contributor-consent"] as const;

/** Whether the signed-in person has accepted the contributor terms. */
export function useContributorConsent() {
  return useQuery<ConsentResponse>({
    queryKey: CONTRIBUTOR_CONSENT_QUERY_KEY,
    queryFn: async () => fetchJson<ConsentResponse>(CONSENT_URL, { schema: consentResponseSchema }),
  });
}

/**
 * The one-time contributor consent (ADR 0012). Corrections are published and
 * used to train models, so nobody writes before accepting; the text shown is
 * the server's, and that exact text is what the acceptance records.
 */
export function CorrectionConsentCard({ consent }: { consent: ConsentResponse["consent"] }) {
  const t = useTranslations("correction");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const accept = useMutation({
    mutationFn: async () =>
      fetchJson<ConsentResponse>(CONSENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ termsVersion: consent.version }),
        schema: consentResponseSchema,
      }),
    onSuccess: (data) => queryClient.setQueryData(CONTRIBUTOR_CONSENT_QUERY_KEY, data),
    onError: (error) =>
      toast({
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      }),
  });

  return (
    <div className="rounded-lg border p-6" data-testid="correction-consent">
      <h2 className="font-medium">{t("consentTitle")}</h2>
      <p className="mt-2 max-w-2xl text-sm">{consent.text}</p>
      <Button className="mt-4 gap-2" disabled={accept.isPending} onClick={() => accept.mutate()}>
        {accept.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        {t("consentAccept")}
      </Button>
    </div>
  );
}
