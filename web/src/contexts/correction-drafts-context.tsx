"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { z } from "zod";
import { useReloadBlocker } from "@/contexts/reload-safety-context";

const textDraftSchema = z.object({
  text: z.string(),
  baseText: z.string(),
  revisionId: z.string(),
});
const draftsSchema = z.record(z.string(), z.object({
  text: textDraftSchema.optional(),
  comment: z.string().optional(),
}));

type TextDraft = z.infer<typeof textDraftSchema>;
type Drafts = z.infer<typeof draftsSchema>;
type SpanDraft = Drafts[string];
type DraftScopes = Record<string, Drafts>;

interface CorrectionDraftsContextValue {
  scopes: DraftScopes;
  restore: (key: string, drafts: Drafts) => void;
  update: (key: string, spanId: string, change: (current: SpanDraft) => SpanDraft) => void;
}

const CorrectionDraftsContext = createContext<CorrectionDraftsContextValue | undefined>(undefined);

function readDrafts(key: string): Drafts {
  try {
    const parsed = draftsSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function DraftPersistence({ storageKey, drafts }: { storageKey: string; drafts: Drafts }) {
  const hasDrafts = Object.keys(drafts).length > 0;

  useEffect(() => {
    try {
      if (hasDrafts) sessionStorage.setItem(storageKey, JSON.stringify(drafts));
      else sessionStorage.removeItem(storageKey);
    } catch {
      // The app provider retains drafts and reload protection across navigation
      // even when browser storage is blocked or full.
    }
  }, [drafts, hasDrafts, storageKey]);

  useReloadBlocker(
    { id: storageKey, kind: "unsaved-changes", blocksAutomatic: true, blocksManual: true },
    hasDrafts
  );

  useEffect(() => {
    if (!hasDrafts) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [hasDrafts]);

  return null;
}

/** Own drafts above route and responsive layout changes, including the storage fallback. */
export function CorrectionDraftsProvider({ children }: { children: ReactNode }) {
  const [scopes, setScopes] = useState<DraftScopes>({});

  const restore = useCallback((key: string, drafts: Drafts) => {
    setScopes((current) => current[key] ? current : { ...current, [key]: drafts });
  }, []);

  const update = useCallback((key: string, spanId: string, change: (current: SpanDraft) => SpanDraft) => {
    setScopes((scopes) => {
      const current = scopes[key] ?? readDrafts(key);
      const next = { ...current };
      const draft = change(current[spanId] ?? {});
      if (draft.text || draft.comment) next[spanId] = draft;
      else delete next[spanId];
      return { ...scopes, [key]: next };
    });
  }, []);

  const value = useMemo(() => ({ scopes, restore, update }), [scopes, restore, update]);

  return (
    <CorrectionDraftsContext.Provider value={value}>
      {Object.entries(scopes).map(([key, drafts]) => (
        <DraftPersistence key={key} storageKey={key} drafts={drafts} />
      ))}
      {children}
    </CorrectionDraftsContext.Provider>
  );
}

/** Local drafts survive navigation and reloads; only explicit commands save to the server. */
export function useCorrectionDrafts(userId: string, workspaceId: string) {
  const context = useContext(CorrectionDraftsContext);
  if (!context) throw new Error("useCorrectionDrafts must be used within a CorrectionDraftsProvider");
  const { scopes, restore, update } = context;
  const key = `besedy-correction-drafts:v1:${userId}:${workspaceId}`;
  const storedDrafts = useMemo(() => readDrafts(key), [key]);
  const drafts = scopes[key] ?? storedDrafts;

  useEffect(() => {
    restore(key, storedDrafts);
  }, [key, restore, storedDrafts]);

  const setText = useCallback((spanId: string, text: TextDraft | undefined) => {
    update(key, spanId, (draft) => ({ ...draft, text }));
  }, [key, update]);

  const setComment = useCallback((spanId: string, comment: string) => {
    update(key, spanId, (draft) => ({ ...draft, comment: comment || undefined }));
  }, [key, update]);

  const clearText = useCallback((spanId: string, submittedText: string) => {
    update(key, spanId, (draft) => draft.text?.text === submittedText ? { ...draft, text: undefined } : draft);
  }, [key, update]);

  const clearComment = useCallback((spanId: string, submittedComment: string) => {
    update(key, spanId, (draft) => draft.comment === submittedComment ? { ...draft, comment: undefined } : draft);
  }, [key, update]);

  return { drafts, setText, setComment, clearText, clearComment };
}
