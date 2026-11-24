"use client";

// Flags on a span's audio (ADR 0012). They never block publication; training
// leaves flagged chunks out. Each toggle is one immutable event on the server.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { SpanView } from "./correction-types";

export const FLAG_KINDS = [
  "UNCLEAR",
  "OVERLAP",
  "OTHER_LANGUAGE",
  "MUSIC_NOISE",
  "CUT_WORD",
  "OTHER",
  "EXCLUDE_FROM_TRAINING",
] as const;

type FlagKind = (typeof FLAG_KINDS)[number];

const LANGUAGES = ["en", "sk", "de", "pl", "ru", "uk", "fr", "es", "it", "la"] as const;

export interface FlagToggle {
  kind: FlagKind;
  set: boolean;
  languageCode: string;
}

interface CorrectionFlagsProps {
  span: SpanView;
  /** The kind being written for this span, while its request is on its way. */
  pendingKind: FlagKind | undefined;
  /** A flag write is on its way, for this span or another: one at a time. */
  busy: boolean;
  /** The editor owns the write, so its pending state outlives this panel. */
  onToggle: (input: FlagToggle) => void;
}

export function CorrectionFlags({ span, pendingKind, busy, onToggle }: CorrectionFlagsProps) {
  const t = useTranslations("correction.flags");
  const [language, setLanguage] = useState<string>("en");

  const active = new Map((span.flags ?? []).map((flag) => [flag.kind, flag]));
  const otherLanguage = active.get("OTHER_LANGUAGE");
  // One event at a time; the buttons stay enabled so focus stays where it was.
  const send = (input: FlagToggle) => {
    if (busy) return;
    onToggle(input);
  };

  return (
    <div className="space-y-1" data-testid="correction-flags">
      <div className="flex flex-wrap items-center gap-1">
        {FLAG_KINDS.map((kind) => {
          const flag = active.get(kind);
          // Every flag keeps the chunk out of training, so correctors are
          // not offered this one; a span that carries it can still clear it.
          if (kind === "EXCLUDE_FROM_TRAINING" && !flag) return null;
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
        {/* The language only matters once the flag is set. */}
        {otherLanguage && (
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
        )}
      </div>
    </div>
  );
}
