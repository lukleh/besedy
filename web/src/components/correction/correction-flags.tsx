"use client";

// Flags on a span's audio (ADR 0012). They never block publication; training
// leaves flagged chunks out. Each toggle is one immutable event on the server.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { fetchJson } from "@/lib/api/fetch-json";
import type { SpanView } from "./correction-types";

export const FLAG_KINDS = [
  "UNCLEAR",
  "OVERLAP",
  "OTHER_LANGUAGE",
  "MUSIC_NOISE",
  "CUT_WORD",
  "EXCLUDE_FROM_TRAINING",
] as const;

type FlagKind = (typeof FLAG_KINDS)[number];

const LANGUAGES = ["en", "sk", "de", "pl", "ru", "uk", "fr", "es", "it", "la"] as const;

interface CorrectionFlagsProps {
  span: SpanView;
  flagsUrl: string;
  onChanged: () => Promise<void> | void;
}

export function CorrectionFlags({ span, flagsUrl, onChanged }: CorrectionFlagsProps) {
  const t = useTranslations("correction.flags");
  const { toast } = useToast();
  const [language, setLanguage] = useState<string>("en");

  const toggle = useMutation({
    mutationFn: async (input: { kind: FlagKind; set: boolean; languageCode: string }) =>
      fetchJson(flagsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: input.kind,
          action: input.set ? "SET" : "CLEAR",
          languageCode: input.kind === "OTHER_LANGUAGE" && input.set ? input.languageCode : null,
          idempotencyKey: crypto.randomUUID(),
        }),
      }),
    onSuccess: () => onChanged(),
    onError: (error) =>
      toast({
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      }),
  });

  const active = new Map((span.flags ?? []).map((flag) => [flag.kind, flag]));
  const otherLanguage = active.get("OTHER_LANGUAGE");
  // One event at a time; the buttons stay enabled so focus stays where it was.
  const pendingKind = toggle.isPending ? toggle.variables?.kind : undefined;
  const send = (input: { kind: FlagKind; set: boolean; languageCode: string }) => {
    if (toggle.isPending) return;
    toggle.mutate(input);
  };

  return (
    <div className="space-y-1" data-testid="correction-flags">
      <p className="text-xs font-medium uppercase text-muted-foreground">{t("label")}</p>
      <div className="flex flex-wrap items-center gap-1">
        {FLAG_KINDS.map((kind) => {
          const flag = active.get(kind);
          return (
            <Button
              key={kind}
              size="sm"
              variant={flag ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              aria-pressed={Boolean(flag)}
              aria-busy={pendingKind === kind}
              onClick={() => send({ kind, set: !flag, languageCode: language })}
              data-testid={`correction-flag-${kind}`}
            >
              {t(kind)}
              {kind === "OTHER_LANGUAGE" && flag?.languageCode ? ` (${flag.languageCode})` : ""}
            </Button>
          );
        })}
        <select
          aria-label={t("language")}
          className="h-7 rounded-md border bg-background px-1 text-xs"
          value={otherLanguage?.languageCode ?? language}
          aria-busy={pendingKind === "OTHER_LANGUAGE"}
          onChange={(event) => {
            const code = event.target.value;
            setLanguage(code);
            // Changing the language of a set flag records it as a new event.
            if (otherLanguage) send({ kind: "OTHER_LANGUAGE", set: true, languageCode: code });
          }}
          data-testid="correction-flag-language"
        >
          {LANGUAGES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
