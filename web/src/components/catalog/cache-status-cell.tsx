"use client";

import { CacheButton } from "@/components/player/cache-button";

interface CacheStatusCellProps {
  hash: string;
  catalogId: string;
}

/**
 * Wrapper for CacheButton in catalog list.
 * Constructs the audio URL from hash and renders the smaller variant.
 */
export function CacheStatusCell({ hash, catalogId }: CacheStatusCellProps) {
  const audioUrl = `/api/catalogs/${catalogId}/recordings/${hash}/audio`;
  return <CacheButton audioUrl={audioUrl} hash={hash} catalogId={catalogId} size="sm" />;
}
