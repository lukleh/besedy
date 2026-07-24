"use client";

import { useCallback, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api/fetch-json";

interface UsePublicationStateOptions {
  activeCatalogId: string | null | undefined;
  onSuccess: (isPublished: boolean) => void;
  onError: (error: unknown) => void;
}

export function usePublicationState({
  activeCatalogId,
  onSuccess,
  onError,
}: UsePublicationStateOptions) {
  const queryClient = useQueryClient();
  const [publishingHashes, setPublishingHashes] = useState<Set<string>>(
    () => new Set()
  );
  const publishingHashesRef = useRef<Set<string>>(new Set());

  const updatePublicationMutation = useMutation({
    mutationFn: async ({
      hash,
      isPublished,
    }: {
      hash: string;
      isPublished: boolean;
    }) => {
      if (!activeCatalogId) {
        throw new Error("No active catalog selected");
      }
      return fetchJson<{ hash: string; isPublished: boolean }>(
        `/api/catalogs/${activeCatalogId}/recordings/${hash}/ready`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isPublished }),
        }
      );
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["catalog"] }),
        queryClient.invalidateQueries({ queryKey: ["catalog-filter-options"] }),
        queryClient.invalidateQueries({ queryKey: ["catalog-entry"] }),
      ]);
    },
  });

  const beginPublishing = useCallback((hash: string): boolean => {
    if (publishingHashesRef.current.has(hash)) {
      return false;
    }
    const next = new Set(publishingHashesRef.current);
    next.add(hash);
    publishingHashesRef.current = next;
    setPublishingHashes(next);
    return true;
  }, []);

  const finishPublishing = useCallback((hash: string) => {
    if (!publishingHashesRef.current.has(hash)) {
      return;
    }
    const next = new Set(publishingHashesRef.current);
    next.delete(hash);
    publishingHashesRef.current = next;
    setPublishingHashes(next);
  }, []);

  const handleTogglePublication = useCallback(
    async (hash: string, isPublished: boolean) => {
      if (!beginPublishing(hash)) {
        return;
      }
      try {
        await updatePublicationMutation.mutateAsync({ hash, isPublished });
        onSuccess(isPublished);
      } catch (error) {
        onError(error);
      } finally {
        finishPublishing(hash);
      }
    },
    [beginPublishing, finishPublishing, onError, onSuccess, updatePublicationMutation]
  );

  return {
    publishingHashes,
    handleTogglePublication,
  };
}
