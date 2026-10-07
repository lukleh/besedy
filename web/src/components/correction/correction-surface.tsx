"use client";

// The working surface: one segment at a time, with its audio, its machine
// text, its history and the four actions. Everything a corrector does here is
// one deliberate command carrying the revision they were looking at.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Check, MessageSquare, SkipForward, ThumbsDown, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";
import {
  buildAudioUrl,
  buildCorrectionNextUrl,
  buildCorrectionSpanCommentsUrl,
  buildCorrectionSpanUrl,
  buildCorrectionSpansUrl,
  buildCorrectionStripUrl,
} from "@/lib/api/recording-urls";
import { AudioPlayer } from "@/components/player/audio-player";
import { CorrectionStrip } from "./correction-strip";
import {
  nextSpanSchema,
  spanCommandResultSchema,
  spanFilterSchema,
  spanHistorySchema,
  spanPageSchema,
  spanStripSchema,
  type SpanFilter,
  type SpanPage,
  type SpanState,
  type SpanView,
  type StripSpan,
  type WorkspaceSummary,
} from "./correction-types";

const PAGE_SIZE = 200;

const FILTERS = spanFilterSchema.options;

interface CorrectionSurfaceProps {
  catalogId: string;
  hash: string;
  userId: string;
  workspace: WorkspaceSummary;
  /** Where this person should pick the work up, if anywhere */
  resume: { spanId: string; ordinal: number } | null;
  onChanged: () => void;
}

interface SpanCommandInput {
  span: SpanView;
  action: "approve" | "disapprove" | "withdraw" | "save_and_approve";
  text?: string;
  /** Minted when the person acts, so a retried request replays rather than repeats */
  idempotencyKey: string;
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function stateVariant(state: SpanState): "default" | "secondary" | "destructive" | "outline" {
  switch (state) {
    case "done":
      return "default";
    case "needs_attention":
      return "destructive";
    case "needs_second_approval":
      return "secondary";
    default:
      return "outline";
  }
}

export function CorrectionSurface({
  catalogId,
  hash,
  userId,
  workspace,
  resume,
  onChanged,
}: CorrectionSurfaceProps) {
  const t = useTranslations("correction");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Nobody finishes a three-hour recording in a sitting, so the surface opens
  // on the first span that still wants this person rather than on the first
  // span of the recording.
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(
    resume?.spanId ?? null
  );
  // Where the list starts. Captured at first: the resume position moves as
  // work is done, and following it would restart the list from a different
  // page under the person. Only a deliberate jump moves it.
  const [anchorOffset, setAnchorOffset] = useState(() =>
    resume ? Math.floor(resume.ordinal / PAGE_SIZE) * PAGE_SIZE : 0
  );
  // Which segments the list shows; it never changes what is selected.
  const [filter, setFilter] = useState<SpanFilter>("all");
  // A jump to a segment that is not loaded yet plays it once it arrives.
  const [playOnArrival, setPlayOnArrival] = useState(false);
  // A filtered list is positioned within the selection, so it starts at its top.
  const initialOffset = filter === "all" ? anchorOffset : 0;
  const [draft, setDraft] = useState("");
  // Set when the stored text moved under a draft. It stays until the person
  // acts or moves on, and while it is set the current stored text is shown
  // beside the editor.
  const [conflict, setConflict] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const [seekRequest, setSeekRequest] = useState<{
    spanId: string;
    time: number;
    end: number;
    key: number;
    autoPlay: boolean;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // The span on screen, for callbacks that outlive the render they came from.
  const selectedIdRef = useRef<string | null>(null);
  // A command whose outcome is not known yet: the response was lost, or the
  // server could not answer. Repeating the same action reuses its key, so
  // the server replays what it recorded instead of refusing a stale revision.
  const pendingCommandRef = useRef<{
    spanId: string;
    revisionId: string;
    action: SpanCommandInput["action"];
    text: string | undefined;
    key: string;
  } | null>(null);

  // A page of the whole recording is positioned by offset, which is stable
  // because spans never come or go. A filtered page is positioned by the
  // ordinal of the last span shown: the selection changes with every decision,
  // and an offset into it would skip or repeat a span after a refresh.
  const spansQuery = useInfiniteQuery<SpanPage, Error, InfiniteData<SpanPage, number>, unknown[], number>({
    queryKey: ["correction-spans", catalogId, hash, workspace.id, filter, initialOffset],
    initialPageParam: filter === "all" ? initialOffset : -1,
    queryFn: async ({ pageParam }) =>
      fetchJson<SpanPage>(
        buildCorrectionSpansUrl(catalogId, hash, {
          ...(filter === "all" ? { offset: pageParam } : { after: pageParam }),
          limit: PAGE_SIZE,
          filter,
        }),
        { schema: spanPageSchema }
      ),
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore) return undefined;
      return filter === "all"
        ? lastPage.offset + lastPage.spans.length
        : lastPage.spans.at(-1)?.ordinal;
    },
    // The list can start in the middle of the recording, so it loads in both
    // directions: pages before the resume position are reachable too. A
    // filtered list always starts at its top.
    getPreviousPageParam: (firstPage) =>
      filter === "all" && firstPage.offset > 0
        ? Math.max(0, firstPage.offset - PAGE_SIZE)
        : undefined,
  });

  const spans = useMemo(
    () => spansQuery.data?.pages.flatMap((page) => page.spans) ?? [],
    [spansQuery.data]
  );

  const selected = useMemo(
    () => spans.find((span) => span.id === selectedSpanId) ?? spans[0] ?? null,
    [spans, selectedSpanId]
  );

  // Changing the filter must not move the person off the segment they are
  // working on. Going back to the whole recording reopens the list on that
  // segment's page; without it the list would restart from wherever it opened,
  // the segment would not be in it, and the editor would silently switch.
  const changeFilter = useCallback(
    (next: SpanFilter) => {
      if (selected) {
        setSelectedSpanId(selected.id);
        if (next === "all") {
          setAnchorOffset(Math.floor(selected.ordinal / PAGE_SIZE) * PAGE_SIZE);
        }
      }
      setFilter(next);
    },
    [selected]
  );

  // A fresh selection starts from the stored text and positions the audio on
  // the span without playing it. When the revision moves under the same span
  // while the draft is dirty, the draft is kept and flagged as a conflict,
  // whatever caused the refresh: the wording is work that would be lost. A
  // clean draft simply follows the stored text. State is adjusted during
  // render, keyed on the span and revision the draft belongs to.
  const [draftFor, setDraftFor] = useState<{
    spanId: string;
    revisionId: string;
    baseText: string;
  } | null>(null);
  if (
    selected &&
    (draftFor?.spanId !== selected.id || draftFor.revisionId !== selected.revisionId)
  ) {
    const spanChanged = draftFor?.spanId !== selected.id;
    if (spanChanged) {
      setDraftFor({ spanId: selected.id, revisionId: selected.revisionId, baseText: selected.text });
      setConflict(false);
      setCommentBody("");
      setDraft(selected.text);
      if (seekRequest?.spanId !== selected.id) {
        setSeekRequest({
          spanId: selected.id,
          time: selected.startSeconds,
          end: selected.endSeconds,
          key: (seekRequest?.key ?? 0) + 1,
          autoPlay: playOnArrival,
        });
      }
      if (playOnArrival) setPlayOnArrival(false);
    } else if (draft.trim() === selected.text.trim()) {
      // The new revision says what the draft says: this person's own save
      // landing, or somebody saving the same wording. Nothing to flag.
      setDraftFor({ ...draftFor, revisionId: selected.revisionId, baseText: selected.text });
      setConflict(false);
    } else if (draft.trim() !== draftFor.baseText.trim()) {
      // Dirty: keep the wording, and keep the baseline it was measured
      // against so later refreshes still see it as unsaved work.
      setDraftFor({ ...draftFor, revisionId: selected.revisionId });
      setConflict(true);
    } else {
      // Clean: follow the stored text, and move the baseline with it so the
      // next revision is measured against this one.
      setDraftFor({ ...draftFor, revisionId: selected.revisionId, baseText: selected.text });
      setDraft(selected.text);
    }
  }

  const historyQuery = useQuery({
    queryKey: ["correction-span-history", catalogId, hash, selected?.id],
    queryFn: async () =>
      fetchJson(buildCorrectionSpanUrl(catalogId, hash, selected!.id), {
        schema: spanHistorySchema,
      }),
    enabled: Boolean(selected?.id),
  });

  const playSpan = useCallback((span: SpanView) => {
    setSeekRequest((previous) => ({
      spanId: span.id,
      time: span.startSeconds,
      end: span.endSeconds,
      key: (previous?.key ?? 0) + 1,
      autoPlay: true,
    }));
  }, []);

  const selectSpan = useCallback(
    (span: SpanView, play = true) => {
      setSelectedSpanId(span.id);
      if (play) playSpan(span);
    },
    [playSpan]
  );

  const stripQuery = useQuery({
    queryKey: ["correction-strip", catalogId, hash, workspace.id],
    queryFn: async () =>
      fetchJson(buildCorrectionStripUrl(catalogId, hash), { schema: spanStripSchema }),
  });

  // Go to a segment wherever it is. One already in the list is just selected;
  // one that is not reloads the list around it, from the whole recording, so a
  // jump never lands on a list that cannot show where it went.
  const jumpTo = useCallback(
    (target: { spanId: string; ordinal: number }) => {
      const loaded = spans.find((span) => span.id === target.spanId);
      if (loaded) {
        selectSpan(loaded);
        return;
      }
      setFilter("all");
      setAnchorOffset(Math.floor(target.ordinal / PAGE_SIZE) * PAGE_SIZE);
      setSelectedSpanId(target.spanId);
      setPlayOnArrival(true);
    },
    [spans, selectSpan]
  );

  // Move on from the span a command was issued on. Anchored on that span
  // rather than on whatever is selected now, and only while it is still the
  // selection: the sidebar stays clickable during a command, and somebody who
  // has already moved on must not be moved again.
  const advance = useCallback(
    async (fromSpanId: string) => {
      if (selectedIdRef.current !== fromSpanId) return;
      const index = spans.findIndex((span) => span.id === fromSpanId);
      if (index < 0) return;
      const next = spans[index + 1];
      if (next) {
        selectSpan(next);
        return;
      }
      if (!spansQuery.hasNextPage) return;

      // The next span is on a page that is not loaded yet. Selecting it has to
      // wait for the fetch, or approving the last span of a page would leave
      // the surface sitting on it with nothing selected and nothing playing.
      const fetched = await spansQuery.fetchNextPage();
      const first = fetched.data?.pages.at(-1)?.spans[0];
      if (first && selectedIdRef.current === fromSpanId) selectSpan(first);
    },
    [spans, selectSpan, spansQuery]
  );

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: ["correction-spans", catalogId, hash, workspace.id],
    });
    await queryClient.invalidateQueries({
      queryKey: ["correction-span-history", catalogId, hash],
    });
    await queryClient.invalidateQueries({
      queryKey: ["correction-strip", catalogId, hash],
    });
    onChanged();
  }, [queryClient, catalogId, hash, workspace.id, onChanged]);

  const command = useMutation({
    mutationFn: async (input: SpanCommandInput) =>
      fetchJson(buildCorrectionSpanUrl(catalogId, hash, input.span.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: input.action,
          expectedRevisionId: input.span.revisionId,
          text: input.text,
          idempotencyKey: input.idempotencyKey,
        }),
        schema: spanCommandResultSchema,
      }),
    onSuccess: async (result, variables) => {
      pendingCommandRef.current = null;
      // The server canonicalizes whitespace and Unicode before saving. Adopt
      // its returned wording only while the submitted draft is still on screen;
      // a newer local edit or another selected span belongs to the person.
      if (variables.action === "save_and_approve" && selectedIdRef.current === variables.span.id) {
        setDraft((current) => (current === variables.text ? result.text : current));
      }
      setConflict(false);
      await refresh();
      if (variables.action === "approve" || variables.action === "save_and_approve") {
        await advance(variables.span.id);
      }
    },
    onError: async (error) => {
      // A definite answer settles the command; a lost connection or a server
      // failure does not, and the key stays for a retry.
      if (error instanceof ApiError && error.status < 500) {
        pendingCommandRef.current = null;
      }
      if (error instanceof ApiError && error.status === 409) {
        const payload = error.payload as { code?: string } | undefined;
        if (payload?.code === "REVISION_CONFLICT") {
          // The refresh brings the newer revision; a dirty draft is then kept
          // and flagged, so the author decides whether their change applies.
          setConflict(true);
          await refresh();
          toast({ description: t("conflict"), variant: "destructive" });
          return;
        }
      }
      toast({
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  const issue = useCallback(
    (span: SpanView, action: SpanCommandInput["action"], text?: string) => {
      const pending = pendingCommandRef.current;
      const key =
        pending &&
        pending.spanId === span.id &&
        pending.revisionId === span.revisionId &&
        pending.action === action &&
        pending.text === text
          ? pending.key
          : crypto.randomUUID();
      pendingCommandRef.current = { spanId: span.id, revisionId: span.revisionId, action, text, key };
      command.mutate({ span, action, text, idempotencyKey: key });
    },
    [command]
  );

  const comment = useMutation({
    mutationFn: async (input: { span: SpanView; body: string }) =>
      fetchJson(buildCorrectionSpanCommentsUrl(catalogId, hash, input.span.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revisionId: input.span.revisionId,
          body: input.body,
        }),
      }),
    onSuccess: async () => {
      setCommentBody("");
      await refresh();
    },
    onError: (error) =>
      toast({
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      }),
  });

  const goNext = useMutation({
    mutationFn: async (afterOrdinal: number) =>
      fetchJson(buildCorrectionNextUrl(catalogId, hash, afterOrdinal), { schema: nextSpanSchema }),
    onSuccess: (result) => {
      if (result.next) jumpTo(result.next);
      else toast({ description: t("nothingLeft") });
    },
    onError: (error) =>
      toast({
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      }),
  });

  const isEdited = selected ? draft.trim() !== selected.text.trim() : false;

  const runPrimary = useCallback(() => {
    if (!selected || command.isPending) return;
    if (isEdited) issue(selected, "save_and_approve", draft);
    else issue(selected, "approve");
  }, [selected, command.isPending, isEdited, draft, issue]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        runPrimary();
      }
    },
    [runPrimary]
  );

  useEffect(() => {
    selectedIdRef.current = selected?.id ?? null;
    textareaRef.current?.focus();
  }, [selected?.id]);

  const myDecision = selected
    ? selected.approverIds.includes(userId)
      ? "approved"
      : selected.disapproverIds.includes(userId)
        ? "disapproved"
        : null
    : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="lg:col-span-2">
        <CorrectionStrip
          spans={stripQuery.data?.spans ?? []}
          selectedOrdinal={selected?.ordinal ?? null}
          onJump={(span: StripSpan) => jumpTo(span)}
        />
      </div>
      <aside className="max-h-[70vh] space-y-1 overflow-y-auto rounded-lg border p-2">
        <div
          role="group"
          aria-label={t("filters.label")}
          className="sticky top-0 z-10 -mx-2 -mt-2 mb-1 flex flex-wrap gap-1 border-b bg-background p-2"
        >
          {FILTERS.map((candidate) => (
            <Button
              key={candidate}
              size="sm"
              variant={candidate === filter ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              aria-pressed={candidate === filter}
              onClick={() => changeFilter(candidate)}
              data-testid={`correction-filter-${candidate}`}
            >
              {t(`filters.${candidate}`)}
            </Button>
          ))}
        </div>
        {spans.length === 0 && !spansQuery.isLoading && (
          <p className="px-2 py-3 text-sm text-muted-foreground">{t("filters.empty")}</p>
        )}
        {spansQuery.hasPreviousPage && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={spansQuery.isFetchingPreviousPage}
            onClick={() => spansQuery.fetchPreviousPage()}
          >
            {t("loadEarlier")}
          </Button>
        )}
        {spans.map((span) => (
          <button
            key={span.id}
            type="button"
            onClick={() => selectSpan(span)}
            className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted ${
              span.id === selected?.id ? "bg-muted" : ""
            }`}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {formatClock(span.startSeconds)}
              </span>
              <Badge variant={stateVariant(span.state)} className="shrink-0 text-[10px]">
                {t(
                  span.state === "done"
                    ? "stateDone"
                    : span.state === "needs_attention"
                      ? "stateNeedsAttention"
                      : span.state === "needs_second_approval"
                        ? "stateNeedsSecondApproval"
                        : "stateNotReviewed"
                )}
              </Badge>
            </span>
            <span className="mt-0.5 line-clamp-2 block text-muted-foreground">
              {span.text}
            </span>
          </button>
        ))}
        {spansQuery.hasNextPage && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={spansQuery.isFetchingNextPage}
            onClick={() => spansQuery.fetchNextPage()}
          >
            {t("loadLater")}
          </Button>
        )}
      </aside>

      <section className="space-y-4">
        <AudioPlayer
          src={buildAudioUrl(catalogId, hash, "archived", [])}
          catalogId={catalogId}
          seekTo={seekRequest?.time}
          seekKey={seekRequest?.key}
          playbackEnd={seekRequest?.end}
          autoPlayOnSeek={seekRequest?.autoPlay ?? false}
        />

        {selected ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>
                {t("spanOf", {
                  index: selected.ordinal + 1,
                  total: workspace.spanCount,
                })}
              </span>
              <span className="font-mono">
                {formatClock(selected.startSeconds)}–{formatClock(selected.endSeconds)}
              </span>
              <Badge variant={stateVariant(selected.state)}>
                {t(
                  selected.state === "done"
                    ? "stateDone"
                    : selected.state === "needs_attention"
                      ? "stateNeedsAttention"
                      : selected.state === "needs_second_approval"
                        ? "stateNeedsSecondApproval"
                        : "stateNotReviewed"
                )}
              </Badge>
            </div>

            {conflict && (
              <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p>{t("conflict")}</p>
                <p className="text-xs font-medium uppercase text-muted-foreground">
                  {t("currentText")}
                </p>
                <p data-testid="conflict-current-text">{selected.text}</p>
              </div>
            )}

            <Textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              rows={5}
              className="text-base leading-relaxed"
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={runPrimary} disabled={command.isPending} className="gap-2">
                <Check className="h-4 w-4" />
                {isEdited
                  ? draft.trim() === ""
                    ? t("clearApproveAndContinue")
                    : t("saveApproveAndContinue")
                  : t("approveAndContinue")}
              </Button>
              <Button
                variant="outline"
                className="gap-2"
                disabled={command.isPending}
                onClick={() => issue(selected, "disapprove")}
              >
                <ThumbsDown className="h-4 w-4" />
                {t("disapprove")}
              </Button>
              {myDecision && (
                <Button
                  variant="ghost"
                  className="gap-2"
                  disabled={command.isPending}
                  onClick={() => issue(selected, "withdraw")}
                >
                  <Undo2 className="h-4 w-4" />
                  {t("withdraw")}
                </Button>
              )}
              <Button
                variant="ghost"
                className="gap-2"
                disabled={command.isPending || goNext.isPending}
                onClick={() => goNext.mutate(selected.ordinal)}
                data-testid="correction-next-open"
              >
                <SkipForward className="h-4 w-4" />
                {t("nextOpen")}
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">{t("shortcutHint")}</p>

            {selected.isEdited && (
              <div className="rounded-md border bg-muted/40 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">
                  {t("original")}
                </p>
                <p className="mt-1 text-sm">{selected.originalText}</p>
              </div>
            )}

            <div className="space-y-2">
              <Textarea
                value={commentBody}
                onChange={(event) => setCommentBody(event.target.value)}
                rows={2}
                placeholder={t("commentPlaceholder")}
              />
              <Button
                size="sm"
                variant="outline"
                className="gap-2"
                disabled={!commentBody.trim() || comment.isPending}
                onClick={() => comment.mutate({ span: selected, body: commentBody })}
              >
                <MessageSquare className="h-4 w-4" />
                {t("addComment")}
              </Button>
            </div>

            <div className="rounded-md border p-3">
              <p className="text-xs font-medium uppercase text-muted-foreground">
                {t("history")}
              </p>
              <ul className="mt-2 space-y-1 text-sm">
                {historyQuery.data?.history.map((entry, index) => (
                  <li key={`${entry.kind}-${index}`} className="text-muted-foreground">
                    <span className="font-mono text-xs">
                      {new Date(entry.at).toLocaleString()}
                    </span>{" "}
                    <span className="font-medium text-foreground">
                      {entry.actorName ?? t("unknownActor")}
                    </span>{" "}
                    <span>{entry.kind}</span>
                    {entry.decision ? ` · ${entry.decision.toLowerCase()}` : ""}
                    {entry.body ? ` · ${entry.body}` : ""}
                    {entry.kind === "revision" && entry.text !== undefined && (
                      <span className="block whitespace-pre-wrap pl-4 text-foreground">
                        {entry.text === "" ? t("emptyRevision") : entry.text}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
