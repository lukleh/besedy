"use client";

// The optional data drawn over the transcript text. Each layer is one entry
// here; the View menu lists them and one stored preference holds them all, so
// a new layer needs no new control or storage key of its own.

import { useCallback, useMemo } from "react";
import { Clock, Users, type LucideIcon } from "lucide-react";
import { useHydratedState } from "@/hooks/use-hydrated-state";

export type TranscriptLayerId = "timestamps" | "speakers";

export interface TranscriptLayer {
  id: TranscriptLayerId;
  /** Message key in the `transcript` namespace. */
  labelKey: string;
  icon: LucideIcon;
  defaultVisible: boolean;
  /** The key the layer was stored under before the View menu existed. */
  legacyPrefKey?: string;
}

export const TRANSCRIPT_LAYERS: readonly TranscriptLayer[] = [
  {
    id: "timestamps",
    labelKey: "timestamps",
    icon: Clock,
    defaultVisible: true,
    legacyPrefKey: "besedy-timestamps",
  },
  {
    id: "speakers",
    labelKey: "speakers",
    icon: Users,
    defaultVisible: true,
    legacyPrefKey: "besedy-speaker-labels",
  },
];

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

function readLegacyVisibility(): Partial<TranscriptLayerVisibility> {
  const visibility: Partial<TranscriptLayerVisibility> = {};
  try {
    for (const layer of TRANSCRIPT_LAYERS) {
      const stored = layer.legacyPrefKey
        ? localStorage.getItem(layer.legacyPrefKey)
        : null;
      if (stored !== null) visibility[layer.id] = stored === "true";
    }
  } catch {
    // Storage unavailable: fall back to the defaults.
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
  const [stored, setStored, isHydrated] = useHydratedState<StoredVisibility>(
    TRANSCRIPT_LAYERS_PREF_KEY,
    null,
    { deserialize: parseStored }
  );

  const visibility = useMemo(() => {
    // Until something is stored under the new key, the old per-layer switches
    // still say what the reader chose.
    const chosen = stored ?? (isHydrated ? readLegacyVisibility() : {});
    return Object.fromEntries(
      TRANSCRIPT_LAYERS.map((layer) => [
        layer.id,
        chosen[layer.id] ?? layer.defaultVisible,
      ])
    ) as TranscriptLayerVisibility;
  }, [stored, isHydrated]);

  const setLayerVisible = useCallback(
    (id: TranscriptLayerId, visible: boolean) => {
      setStored({ ...visibility, [id]: visible });
    },
    [visibility, setStored]
  );

  return [visibility, setLayerVisible];
}
