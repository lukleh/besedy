"use client";

// The optional data drawn over the transcript text. Each layer is one entry
// here; the View menu lists them and one stored preference holds them all, so
// a new layer needs no new control or storage key of its own.

import { useCallback, useMemo, useEffect } from "react";
import { Clock, Users, type LucideIcon } from "lucide-react";
import { migrateBrowserStorage } from "@/lib/browser-storage";
import { useHydratedState } from "@/hooks/use-hydrated-state";

export type TranscriptLayerId = "timestamps" | "speakers";

export interface TranscriptLayer {
  id: TranscriptLayerId;
  /** Message key in the `transcript` namespace. */
  labelKey: string;
  icon: LucideIcon;
  defaultVisible: boolean;
}

export const TRANSCRIPT_LAYERS: readonly TranscriptLayer[] = [
  {
    id: "timestamps",
    labelKey: "timestamps",
    icon: Clock,
    defaultVisible: true,
  },
  {
    id: "speakers",
    labelKey: "speakers",
    icon: Users,
    defaultVisible: true,
  },
];

/**
 * Whether a layer can be shown for the recording on screen: its data is
 * there, still loading, or the recording has none.
 */
export type LayerState = "available" | "loading" | "unavailable";

export const TRANSCRIPT_LAYERS_PREF_KEY = "besedy-transcript-layers";

export type TranscriptLayerVisibility = Record<TranscriptLayerId, boolean>;
type StoredVisibility = Partial<TranscriptLayerVisibility> | null;

function parseStored(stored: string): StoredVisibility {
  const parsed: unknown = JSON.parse(stored);
  if (!parsed || typeof parsed !== "object") return null;
  const visibility: Partial<TranscriptLayerVisibility> = {};
  for (const layer of TRANSCRIPT_LAYERS) {
    const value = (parsed as Record<string, unknown>)[layer.id];
    if (typeof value === "boolean") visibility[layer.id] = value;
  }
  return visibility;
}

/**
 * The reader's chosen layers, before availability: a layer the recording or
 * the account cannot show stays chosen, so it returns where it can be shown.
 */
export function useTranscriptLayers(): [
  TranscriptLayerVisibility,
  (id: TranscriptLayerId, visible: boolean) => void,
] {
  useEffect(migrateBrowserStorage, []);
  const [stored, setStored] = useHydratedState<StoredVisibility>(
    TRANSCRIPT_LAYERS_PREF_KEY,
    null,
    { deserialize: parseStored }
  );

  const visibility = useMemo(() => {
    const chosen = stored ?? {};
    return Object.fromEntries(
      TRANSCRIPT_LAYERS.map((layer) => [
        layer.id,
        chosen[layer.id] ?? layer.defaultVisible,
      ])
    ) as TranscriptLayerVisibility;
  }, [stored]);

  const setLayerVisible = useCallback(
    (id: TranscriptLayerId, visible: boolean) => {
      setStored({ ...visibility, [id]: visible });
    },
    [visibility, setStored]
  );

  return [visibility, setLayerVisible];
}
