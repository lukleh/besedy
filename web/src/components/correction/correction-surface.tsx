"use client";

// The working surface: one segment at a time, with its audio, its machine
// text, its history and the four actions. Everything a corrector does here is
// one deliberate command carrying the revision they were looking at.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Check, Eraser, Link as LinkIcon, MessageSquare, Pause, Play, SkipForward, ThumbsDown, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";
import { copyToClipboard } from "@/lib/clipboard";
import {
  buildAudioUrl,
  buildCorrectionNextUrl,
  buildCorrectionPagePath,
  buildCorrectionSpanCommentsUrl,
  buildCorrectionSpanUrl,
  buildCorrectionSpansUrl,
  buildCorrectionStripUrl,
} from "@/lib/api/recording-urls";
import { AudioPlayer } from "@/components/player/audio-player";
import type { AudioPlayerHandle } from "@/components/player/audio-player-types";
import { formatClock } from "@/lib/correction/format";
import {
  MIN_HEARD_FRACTION_FOR_TRAINING,
  PlaybackTracker,
  speechRegionsInSeconds,
} from "@/lib/correction/playback-coverage";
import { CorrectionStrip } from "./correction-strip";
import { CorrectionFlags } from "./correction-flags";
import { CorrectionGuideDialog } from "./correction-guide-dialog";
import { CORRECTION_PAGE_SIZE as PAGE_SIZE, useCorrectionSegmentLink } from "./use-correction-segment-link";
import { useCorrectionDrafts } from "@/contexts/correction-drafts-context";
import {
  CorrectionSpanAudio,
  PLAYBACK_RATES,
  canResumeSpan,
  regionIndexAt,
  spanAudioRegions,
  spanPlaybackAction,
  type TimeSubscription,
} from "./correction-span-audio";
import {
  nextSpanSchema,
  spanCommandResultSchema,
  spanHistorySchema,
  spanKindSchema,
  spanPageSchema,
  spanStripSchema,
  type SpanKind,
  type SpanPage,
  type SpanState,
  type SpanView,
  type StripSpan,
  type WorkspaceSummary,
} from "./correction-types";

const KINDS = spanKindSchema.options;

// Scroll only the segment list. Element.scrollIntoView() would also scroll
// the page, which on a phone pulls the editor below the list out of view on
// every move to another segment.
function revealInList(list: HTMLElement, item: HTMLElement) {
  const listRect = list.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top;
  else if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom;
}

/**
 * How many spans of each kind the strip holds. `wantsMe` comes from the
 * server, so the rule for what still wants a person is not restated here.
 */
export function countKinds(spans: readonly StripSpan[]): Record<SpanKind, number> {
  const counts: Record<SpanKind, number> = {
    mine_open: 0,
    needs_attention: 0,
    needs_second_approval: 0,
    not_reviewed: 0,
  };
  for (const span of spans) {
    if (span.wantsMe) counts.mine_open += 1;
    if (span.state !== "done") counts[span.state] += 1;
  }
  return counts;
}

interface CorrectionSurfaceProps {
  catalogId: string;
  hash: string;
  userId: string;
  workspace: WorkspaceSummary;
  /** Where this person should pick the work up, if anywhere */
  resume: { spanId: string; ordinal: number } | null;
  /** The catalog's correction guide, in Markdown */
  guide: string;
  onChanged: () => void;
}

interface SpanCommandInput {
  span: SpanView;
  action: "approve" | "disapprove" | "withdraw" | "save_and_approve";
  text?: string;
  /** Exact local wording settled by this command, to preserve typing made while it runs. */
  draftToClear?: string;
  /** Minted when the person acts, so a retried request replays rather than repeats */
  idempotencyKey: string;
  /** What the person heard of the span, measured when they acted (ADR 0012) */
  playback?: PlaybackReport;
}

type PlaybackReport = ReturnType<PlaybackTracker["report"]>;

/** Playback shares change often; the meter moves in steps so nothing re-renders per tick. */
const HEARD_STEP = 0.05;

/** The share of the regions played, floored to a step; never above the exact share. */
function steppedHeard(tracker: PlaybackTracker, regions: readonly (readonly [number, number])[]): number {
  const coverage = tracker.played.coverage(regions);
  return Math.min(1, Math.floor(coverage / HEARD_STEP + 1e-9) * HEARD_STEP);
}

/**
 * How much of the span this person has heard, and what is still needed
 * before approving. Follows the player through the time subscription, so
 * its ticks re-render this line only, not the list and the strip above it.
 */
function HeardMeter({
  span,
  tracker,
  subscribeTime,
  mustListen,
  playRequested,
  onPlay,
}: {
  span: SpanView;
  tracker: PlaybackTracker;
  subscribeTime: TimeSubscription;
  mustListen: boolean;
  playRequested: boolean;
  onPlay: () => void;
}) {
  const t = useTranslations("correction");
  const regions = useMemo(() => speechRegionsInSeconds(span), [span]);
  const [heard, setHeard] = useState(() => steppedHeard(tracker, regions));
  // Only whether the span can be resumed, not the time itself, so the meter
  // re-renders when that flips rather than on every time update.
  const [resumable, setResumable] = useState(false);
  useEffect(() => {
    const measure = (time: number) => {
      const next = steppedHeard(tracker, regions);
      setHeard((current) => (current === next ? current : next));
      setResumable(canResumeSpan(span, time));
    };
    return subscribeTime(measure);
  }, [span, tracker, regions, subscribeTime]);
  const playbackAction = spanPlaybackAction(playRequested, resumable);

  return (
    <div
      className={`flex flex-wrap items-center gap-2 text-xs ${mustListen ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
      data-testid="correction-heard"
      data-heard={heard.toFixed(2)}
    >
      <span>{t("heard", { percent: Math.round(heard * 100) })}</span>
      {mustListen && (
        <>
          <span>
            {t("listenBeforeApprove", {
              percent: Math.round(MIN_HEARD_FRACTION_FOR_TRAINING * 100),
            })}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={onPlay}
            data-native-space
          >
            {playRequested ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {t(`audio.${playbackAction}`)}
          </Button>
        </>
      )}
    </div>
  );
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
  guide,
  onChanged,
}: CorrectionSurfaceProps) {
  const t = useTranslations("correction");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const localDrafts = useCorrectionDrafts(userId, workspace.id);

  const [draft, setDraft] = useState("");
  // Whether the selected span still needs listening before it can be
  // approved. The share itself is shown by HeardMeter, which follows the
  // player on its own; the surface only re-renders when the gate flips.
  const [mustListen, setMustListen] = useState(true);
  // Set when the stored text moved under a draft. It stays until the person
  // acts or moves on, and while it is set the current stored text is shown
  // beside the editor.
  const [conflict, setConflict] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  // What this person has played on this page, for the playback each approve
  // or disapprove reports (ADR 0012). Only continuous playing counts. State,
  // not a ref, because the render that selects a span reads it for the gate.
  const [playback] = useState(() => new PlaybackTracker());
  const playingRef = useRef(false);
  const playerRef = useRef<AudioPlayerHandle>(null);
  // Playing, or about to: what the span buttons offer and what they do.
  const [playRequested, setPlayRequested] = useState(false);
  const [rate, setRate] = useState<number>(1);

  // The playback time reaches the parts that follow it through a
  // subscription, not state, so the surface does not re-render four times a
  // second while audio plays.
  const currentTimeRef = useRef(0);
  const timeListenersRef = useRef(new Set<(time: number) => void>());
  const subscribeTime = useCallback<TimeSubscription>((listener) => {
    const listeners = timeListenersRef.current;
    listeners.add(listener);
    // A part mounted for a new selection starts from where the audio is; the
    // seek that positioned it may have been announced before it subscribed.
    listener(currentTimeRef.current);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  // The player re-subscribes its media listeners whenever these change, which
  // would also drop its frame-precise excerpt stop, so they stay stable and
  // read the current rate from a ref instead of closing over it.
  const rateRef = useRef(rate);
  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);
  // The speech of the span on screen, for the heard meter; a ref so the time
  // callback stays stable and keeps the player's media listeners in place.
  const selectedRegionsRef = useRef<[number, number][]>([]);
  const measureHeard = useCallback(() => {
    const heard = steppedHeard(playback, selectedRegionsRef.current);
    const next = heard < MIN_HEARD_FRACTION_FOR_TRAINING;
    setMustListen((current) => (current === next ? current : next));
  }, [playback]);
  const handlePlayerTime = useCallback(
    (time: number) => {
      currentTimeRef.current = time;
      // Observe before notifying, so the meter reads the interval this tick added.
      if (playingRef.current) playback.observe(time, rateRef.current);
      else playback.interrupt();
      timeListenersRef.current.forEach((listener) => listener(time));
      if (playingRef.current) measureHeard();
    },
    [measureHeard, playback]
  );
  const handlePlayerPlaying = useCallback((playing: boolean) => {
    playingRef.current = playing;
    const time = playerRef.current?.getCurrentTime();
    if (time !== undefined) {
      currentTimeRef.current = time;
      timeListenersRef.current.forEach((listener) => listener(time));
    }
    if (playing) {
      // The first time update after play lands a quarter second in; seeding
      // the tracker with the position play started from counts that lead,
      // which a span of a second or two could otherwise never cover.
      playback.observe(currentTimeRef.current, rateRef.current);
    } else {
      playback.interrupt();
    }
  }, [playback]);
  const handlePlayerSeek = useCallback(() => playback.interrupt(), [playback]);

  const [seekRequest, setSeekRequest] = useState<{
    spanId: string;
    time: number;
    end: number;
    key: number;
    autoPlay: boolean;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLElement | null>(null);
  const selectedListItemRef = useRef<HTMLButtonElement | null>(null);
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

  const pauseForNavigation = useCallback(() => {
    playerRef.current?.pause();
    playingRef.current = false;
    setPlayRequested(false);
    // A blocked link unmounts the player; recovery must not replay its old
    // autoplay request when the same segment's player mounts again.
    setSeekRequest((current) => current?.autoPlay ? { ...current, autoPlay: false } : current);
    playback.interrupt();
  }, [playback]);
  const stripQuery = useQuery({
    queryKey: ["correction-strip", catalogId, hash, workspace.id],
    queryFn: async () =>
      fetchJson(buildCorrectionStripUrl(catalogId, hash), { schema: spanStripSchema }),
  });
  const segmentLink = useCorrectionSegmentLink({
    catalogId, hash, resume,
    spans: stripQuery.data?.spans,
    status: stripQuery.status,
    onNavigate: pauseForNavigation,
  });
  const { selectedSpanId, anchorOffset } = segmentLink;
  const selectLinkedSegment = segmentLink.select;

  // The list always holds the whole recording, so the segment being worked on
  // is always in it. Finding the segments that want attention is the job of
  // "next" and the strip, not of a narrower list whose members would change
  // with every decision.
  const spansQuery = useInfiniteQuery<SpanPage>({
    queryKey: ["correction-spans", catalogId, hash, workspace.id, anchorOffset],
    initialPageParam: anchorOffset,
    enabled: !segmentLink.pending && !segmentLink.missing,
    queryFn: async ({ pageParam }) =>
      fetchJson<SpanPage>(
        buildCorrectionSpansUrl(catalogId, hash, {
          offset: pageParam as number,
          limit: PAGE_SIZE,
        }),
        { schema: spanPageSchema }
      ),
    getNextPageParam: (lastPage) => {
      const next = lastPage.offset + lastPage.spans.length;
      return next < lastPage.total ? next : undefined;
    },
    // The list can start in the middle of the recording, so it loads in both
    // directions: pages before the resume position are reachable too.
    getPreviousPageParam: (firstPage) =>
      firstPage.offset > 0 ? Math.max(0, firstPage.offset - PAGE_SIZE) : undefined,
  });

  const spans = useMemo(
    () => spansQuery.data?.pages.flatMap((page) => page.spans) ?? [],
    [spansQuery.data]
  );

  const selected = useMemo(
    () => segmentLink.pending || segmentLink.missing ? null
      : spans.find((span) => span.id === selectedSpanId) ?? (!segmentLink.linked ? spans[0] ?? null : null),
    [spans, selectedSpanId, segmentLink.pending, segmentLink.missing, segmentLink.linked]
  );
  const syncSegmentUrl = segmentLink.syncUrl;
  useEffect(() => {
    if (selected) syncSegmentUrl(selected.id);
  }, [selected, syncSegmentUrl]);
  useEffect(() => {
    if (listRef.current && selectedListItemRef.current) {
      revealInList(listRef.current, selectedListItemRef.current);
    }
  }, [selected?.id]);

  // A fresh selection restores any local draft and positions the audio on
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
      // A draft kept for this span comes back, flagged as a conflict when the
      // stored text moved away from the text it was written against. The
      // baseline is compared rather than the revision: a draft already flagged
      // once records the newer revision, and leaving and returning must not
      // clear the flag. A draft that says what the span now says is no
      // unsaved work; the effect below drops it.
      const saved = localDrafts.drafts[selected.id];
      const restored =
        saved?.text && saved.text.text.trim() !== selected.text.trim() ? saved.text : undefined;
      setDraftFor({
        spanId: selected.id,
        revisionId: selected.revisionId,
        baseText: restored?.baseText ?? selected.text,
      });
      setConflict(Boolean(restored && restored.baseText.trim() !== selected.text.trim()));
      setCommentBody(saved?.comment ?? "");
      setDraft(restored?.text ?? selected.text);
      // The gate follows the span in the same render, so the approve button
      // never shows the previous span's listening for even one frame.
      setMustListen(
        steppedHeard(playback, speechRegionsInSeconds(selected)) < MIN_HEARD_FRACTION_FOR_TRAINING
      );
      if (seekRequest?.spanId !== selected.id) {
        setSeekRequest({
          spanId: selected.id,
          time: selected.startSeconds,
          end: selected.endSeconds,
          key: (seekRequest?.key ?? 0) + 1,
          autoPlay: false,
        });
      }
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

  // The time callback measures against the span on screen; a span revisited
  // on the same page keeps what was heard of it, because the tracker
  // remembers every interval played since the page opened.
  const selectedRegions = useMemo(() => (selected ? speechRegionsInSeconds(selected) : []), [selected]);
  useEffect(() => {
    selectedRegionsRef.current = selectedRegions;
    measureHeard();
  }, [selectedRegions, measureHeard]);

  // A kept draft that says what the span now says is no unsaved work any
  // more: somebody saved that wording meanwhile, or this person's own save
  // landed after they moved on. Dropping it ends its badge and reload warning.
  const clearLocalText = localDrafts.clearText;
  const selectedDraftText = selected ? localDrafts.drafts[selected.id]?.text?.text : undefined;
  useEffect(() => {
    if (selected && selectedDraftText !== undefined && selectedDraftText.trim() === selected.text.trim()) {
      clearLocalText(selected.id, selectedDraftText);
    }
  }, [selected, selectedDraftText, clearLocalText]);

  const historyQuery = useQuery({
    queryKey: ["correction-span-history", catalogId, hash, selected?.id],
    queryFn: async () =>
      fetchJson(buildCorrectionSpanUrl(catalogId, hash, selected!.id), {
        schema: spanHistorySchema,
      }),
    enabled: Boolean(selected?.id),
  });

  const playSpan = useCallback((span: SpanView) => {
    playback.interrupt();
    setSeekRequest((previous) => ({
      spanId: span.id,
      time: span.startSeconds,
      end: span.endSeconds,
      key: (previous?.key ?? 0) + 1,
      autoPlay: true,
    }));
  }, [playback]);

  /** Play part of a span: a region, from a word, or a few seconds back. */
  const playRange = useCallback((span: SpanView, start: number, end: number) => {
    playback.interrupt();
    setSeekRequest((previous) => ({
      spanId: span.id,
      time: Math.max(span.startSeconds, start),
      end: Math.min(span.endSeconds, end),
      key: (previous?.key ?? 0) + 1,
      autoPlay: true,
    }));
  }, [playback]);

  const toggleSpanPlayback = useCallback((span: SpanView) => {
    const player = playerRef.current;
    if (!player) return;
    if (player.isPlayRequested()) {
      player.pause();
      return;
    }
    // Anywhere inside the span plays on from there to its end; a finished or
    // unrelated position starts the span over.
    const time = player.getCurrentTime();
    if (time >= span.startSeconds && time < span.endSeconds) {
      player.play(span.endSeconds);
    } else {
      playSpan(span);
    }
  }, [playSpan]);

  const playRegion = useCallback(
    (span: SpanView, direction: "previous" | "current" | "next") => {
      const regions = spanAudioRegions(span);
      if (regions.length === 0) return;
      const index = regionIndexAt(regions, currentTimeRef.current);
      const target =
        direction === "previous"
          ? Math.max(0, index - 1)
          : direction === "next"
            ? Math.min(regions.length - 1, index + 1)
            : index;
      playRange(span, regions[target].start, regions[target].end);
    },
    [playRange]
  );

  /** Replay from three seconds back, or the span's last three once past its end. */
  const playBack = useCallback(
    (span: SpanView) => {
      const back = Math.min(span.endSeconds, Math.max(span.startSeconds, currentTimeRef.current - 3));
      const start = back < span.endSeconds ? back : Math.max(span.startSeconds, span.endSeconds - 3);
      playRange(span, start, span.endSeconds);
    },
    [playRange]
  );

  const cycleRate = useCallback(() => {
    setRate((current) => {
      const index = PLAYBACK_RATES.indexOf(current as (typeof PLAYBACK_RATES)[number]);
      return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
    });
  }, []);

  const selectSpan = useCallback(
    (span: SpanView) => {
      // The span on screen keeps its position and playback: clicking it
      // again must not throw away where the person paused.
      if (span.id === selectedIdRef.current) return;
      selectLinkedSegment({ spanId: span.id, ordinal: span.ordinal });
      setSeekRequest((previous) => ({
        spanId: span.id,
        time: span.startSeconds,
        end: span.endSeconds,
        key: (previous?.key ?? 0) + 1,
        autoPlay: false,
      }));
    },
    [selectLinkedSegment]
  );

  const kindCounts = useMemo(() => countKinds(stripQuery.data?.spans ?? []), [stripQuery.data]);

  // Go to a segment wherever it is. One already in the list is just selected;
  // one that is not reloads the list around its page.
  const jumpTo = useCallback(
    (target: { spanId: string; ordinal: number }) => {
      const loaded = spans.find((span) => span.id === target.spanId);
      if (loaded) {
        selectSpan(loaded);
        return;
      }
      selectLinkedSegment(target, { reanchor: true });
    },
    [spans, selectSpan, selectLinkedSegment]
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
      // wait for the fetch, so the editor and player both select the next span.
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
          playback: input.playback,
        }),
        schema: spanCommandResultSchema,
      }),
    onSuccess: async (result, variables) => {
      pendingCommandRef.current = null;
      if (variables.draftToClear !== undefined) {
        localDrafts.clearText(variables.span.id, variables.draftToClear);
      }
      // The server canonicalizes whitespace and Unicode before saving. Adopt
      // its returned wording only while the submitted draft is still on screen;
      // a newer local edit or another selected span belongs to the person.
      if (variables.action === "save_and_approve" && selectedIdRef.current === variables.span.id) {
        setDraft((current) => (current === variables.text ? result.text : current));
      }
      // The saved wording is the new baseline at once, so the span does not
      // look edited between the save and the refetched list.
      setDraftFor((current) =>
        current && current.spanId === variables.span.id
          ? { ...current, revisionId: result.revisionId, baseText: result.text }
          : current
      );
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
        if (payload?.code === "WORKSPACE_LOCKED") {
          // A publication or another writer holds the workspace; the draft
          // stays and the refresh shows the publication's state.
          await refresh();
          toast({ description: t("workspaceLocked"), variant: "destructive" });
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
      // Approvals and disapprovals report what was heard of this span; the
      // measurement is never a condition for deciding.
      const report = action === "withdraw" ? undefined : playback.report(speechRegionsInSeconds(span));
      const draftText = localDrafts.drafts[span.id]?.text?.text;
      const draftToClear = action === "save_and_approve"
        ? text
        : action === "approve" && draftText?.trim() === span.text.trim() ? draftText : undefined;
      command.mutate({ span, action, text, draftToClear, idempotencyKey: key, playback: report });
    },
    [command, localDrafts.drafts, playback]
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
    onSuccess: async (_result, variables) => {
      localDrafts.clearComment(variables.span.id, variables.body);
      if (selectedIdRef.current === variables.span.id) {
        setCommentBody((current) => current === variables.body ? "" : current);
      }
      await refresh();
    },
    onError: (error) =>
      toast({
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      }),
  });

  // The next span of a kind after the one on screen, wrapping round. The
  // server answers, so a decision somebody else made a moment ago counts.
  const goNext = useMutation({
    mutationFn: async (kind: SpanKind) =>
      fetchJson(
        buildCorrectionNextUrl(catalogId, hash, { after: selected?.ordinal ?? -1, kind }),
        { schema: nextSpanSchema }
      ),
    onSuccess: (result, kind) => {
      if (result.next) jumpTo(result.next);
      else toast({ description: kind === "mine_open" ? t("nothingLeft") : t("jump.none") });
    },
    onError: (error) =>
      toast({
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      }),
  });

  const isEdited = selected ? draft.trim() !== selected.text.trim() : false;
  // An approval made without listening is stored, but training leaves it out
  // (ADR 0012), and the person would only learn that at export time. The
  // editor asks for the listening first; disapproving and withdrawing do not
  // need it.
  const runPrimary = useCallback(() => {
    if (!selected || command.isPending) return;
    if (mustListen) {
      // Reached from Ctrl+Enter while the button is disabled: say why.
      toast({
        description: t("listenBeforeApprove", {
          percent: Math.round(MIN_HEARD_FRACTION_FOR_TRAINING * 100),
        }),
      });
      return;
    }
    if (isEdited) issue(selected, "save_and_approve", draft);
    else issue(selected, "approve");
  }, [selected, command.isPending, mustListen, isEdited, draft, issue, toast, t]);

  // Back to the stored text, for a draft this person no longer wants, on
  // screen or just restored. A comment being written stays.
  const discardDraft = useCallback(() => {
    if (!selected) return;
    localDrafts.setText(selected.id, undefined);
    setDraft(selected.text);
    setConflict(false);
    setDraftFor((current) =>
      current && current.spanId === selected.id
        ? { ...current, revisionId: selected.revisionId, baseText: selected.text }
        : current
    );
  }, [selected, localDrafts]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        runPrimary();
      }
    },
    [runPrimary]
  );

  // Listening shortcuts use Alt with the physical key, so they work from the
  // text box and do not type the characters Option produces on a Mac. They
  // listen on the document, so they work from anywhere on the page, in the
  // capture phase, so the player's own document listener sees them handled.
  const handleShortcut = useCallback(
    (event: KeyboardEvent) => {
      if (!selected || !event.altKey || event.metaKey || event.ctrlKey) return;
      const actions: Record<string, () => void> = {
        KeyP: () => toggleSpanPlayback(selected),
        KeyR: () => playRegion(selected, "current"),
        ArrowLeft: () => playRegion(selected, "previous"),
        ArrowRight: () => playRegion(selected, "next"),
        KeyB: () => playBack(selected),
        KeyS: () => cycleRate(),
      };
      const action = actions[event.code];
      if (!action) return;
      event.preventDefault();
      action();
    },
    [selected, toggleSpanPlayback, playRegion, playBack, cycleRate]
  );
  const shortcutRef = useRef(handleShortcut);
  useEffect(() => {
    shortcutRef.current = handleShortcut;
  }, [handleShortcut]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcutRef.current(event);
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, []);

  useEffect(() => {
    selectedIdRef.current = selected?.id ?? null;
    textareaRef.current?.focus();
  }, [selected?.id]);

  const previousSpan = selected ? spans.find((span) => span.ordinal === selected.ordinal - 1) : undefined;
  // A span the model wrote nothing for: speech it dropped, or nothing at all.
  const emptyMachineSpan = Boolean(
    selected && selected.originalText === "" && (selected.machineWords ?? []).length === 0
  );

  const myDecision = selected
    ? selected.approverIds.includes(userId)
      ? "approved"
      : selected.disapproverIds.includes(userId)
        ? "disapproved"
        : null
    : null;

  const missingSegment = segmentLink.missing || (
    segmentLink.linked && !segmentLink.pending && spansQuery.isSuccess && !selected
  );
  const linkBlocked = segmentLink.pending || missingSegment;
  const copySegmentLink = async () => {
    if (!selected) return;
    const href = new URL(buildCorrectionPagePath(catalogId, hash, selected.id), window.location.origin).href;
    try {
      await copyToClipboard(href);
      toast({ description: t("segmentLinkCopied") });
    } catch {
      toast({ description: t("segmentLinkCopyFailed"), variant: "destructive" });
    }
  };

  if (linkBlocked) {
    return (
      <div className="rounded-lg border bg-muted/50 p-4" role={missingSegment || stripQuery.isError ? "alert" : "status"}>
        <p className="text-sm">
          {missingSegment ? t("segmentLinkMissing") : stripQuery.isError ? t("segmentLinkLoadFailed") : t("segmentLinkLoading")}
        </p>
        {missingSegment ? (
          <Button className="mt-3" variant="outline" onClick={segmentLink.reset} data-native-space>
            {t("segmentLinkResume")}
          </Button>
        ) : stripQuery.isError && (
          <Button className="mt-3" variant="outline" onClick={() => stripQuery.refetch()} data-native-space>
            {t("segmentLinkRetry")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="lg:col-span-2">
        <CorrectionStrip
          spans={stripQuery.data?.spans ?? []}
          selectedOrdinal={selected?.ordinal ?? null}
          onJump={(span: StripSpan) => jumpTo(span)}
        />
      </div>
      <aside ref={listRef} className="max-h-[70vh] space-y-1 overflow-y-auto rounded-lg border p-2">
        <div
          role="group"
          aria-label={t("jump.label")}
          className="sticky top-0 z-10 -mx-2 -mt-2 mb-1 flex flex-wrap items-center gap-1 border-b bg-background p-2"
        >
          <span className="w-full text-xs text-muted-foreground">{t("jump.label")}</span>
          {KINDS.map((kind) => (
            <Button
              key={kind}
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={goNext.isPending || (stripQuery.isSuccess && kindCounts[kind] === 0)}
              onClick={() => goNext.mutate(kind)}
              data-testid={`correction-jump-${kind}`}
            >
              {t(`jump.${kind}`)}
              {stripQuery.isSuccess && (
                <span className="tabular-nums opacity-70">{kindCounts[kind]}</span>
              )}
            </Button>
          ))}
        </div>
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
            ref={span.id === selected?.id ? selectedListItemRef : undefined}
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
              {span.id !== selected?.id &&
                (localDrafts.drafts[span.id]?.text || localDrafts.drafts[span.id]?.comment) && (
                <Badge variant="outline" className="shrink-0 border-amber-500/60 text-[10px]">
                  {t("unsavedDraft")}
                </Badge>
              )}
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
          ref={playerRef}
          src={buildAudioUrl(catalogId, hash, "archived", [])}
          catalogId={catalogId}
          seekTo={seekRequest?.time}
          seekKey={seekRequest?.key}
          playbackEnd={seekRequest?.end}
          autoPlayOnSeek={seekRequest?.autoPlay ?? false}
          playbackRate={rate}
          sleepTimerEnabled={false}
          onTimeUpdate={handlePlayerTime}
          onPlayingChange={handlePlayerPlaying}
          onPlayRequestChange={setPlayRequested}
          onSeek={handlePlayerSeek}
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
              <div className="ml-auto flex items-center gap-2">
                <Button variant="outline" size="sm" className="gap-1.5" onClick={copySegmentLink} data-native-space>
                  <LinkIcon className="h-4 w-4" aria-hidden="true" />
                  {t("copySegmentLink")}
                </Button>
                <CorrectionGuideDialog body={guide} />
              </div>
            </div>

            <CorrectionSpanAudio
              span={selected}
              playRequested={playRequested}
              onTogglePlay={() => toggleSpanPlayback(selected)}
              subscribeTime={subscribeTime}
              rate={rate}
              onPlayRange={(start, end) => playRange(selected, start, end)}
              onRegion={(direction) => playRegion(selected, direction)}
              onBack={() => playBack(selected)}
              onCycleRate={cycleRate}
            />

            {previousSpan && previousSpan.text && (
              <p className="text-sm text-muted-foreground" data-testid="correction-previous-context">
                <span className="text-xs uppercase">{t("previousContext")}</span>{" "}
                …{previousSpan.text.slice(-160)}
              </p>
            )}

            {emptyMachineSpan && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm" data-testid="correction-empty-span">
                {t("emptySpan.hint")}
              </p>
            )}

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
              onChange={(event) => {
                const text = event.target.value;
                setDraft(text);
                localDrafts.setText(selected.id, text.trim() === selected.text.trim() ? undefined : {
                  text,
                  baseText: draftFor?.baseText ?? selected.text,
                  revisionId: selected.revisionId,
                });
              }}
              onKeyDown={handleKeyDown}
              rows={5}
              className="text-base leading-relaxed"
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={runPrimary}
                disabled={command.isPending || mustListen}
                className="gap-2"
                data-testid="correction-approve"
              >
                <Check className="h-4 w-4" />
                {isEdited
                  ? draft.trim() === ""
                    ? t("clearApproveAndContinue")
                    : t("saveApproveAndContinue")
                  : draft.trim() === ""
                    ? t("emptySpan.confirm")
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
              {isEdited && (
                <Button
                  variant="ghost"
                  className="gap-2"
                  disabled={command.isPending}
                  onClick={discardDraft}
                  data-testid="correction-discard-draft"
                >
                  <Eraser className="h-4 w-4" />
                  {t("discardDraft")}
                </Button>
              )}
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
                onClick={() => goNext.mutate("mine_open")}
                data-testid="correction-next-open"
              >
                <SkipForward className="h-4 w-4" />
                {t("nextOpen")}
              </Button>
            </div>

            <HeardMeter
              key={selected.id}
              span={selected}
              tracker={playback}
              subscribeTime={subscribeTime}
              mustListen={mustListen}
              playRequested={playRequested}
              onPlay={() => toggleSpanPlayback(selected)}
            />

            <p className="text-xs text-muted-foreground">{t("shortcutHint")}</p>

            <CorrectionFlags
              span={selected}
              flagsUrl={`${buildCorrectionSpanUrl(catalogId, hash, selected.id)}/flags`}
              onChanged={refresh}
            />

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
                onChange={(event) => {
                  setCommentBody(event.target.value);
                  localDrafts.setComment(selected.id, event.target.value);
                }}
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
