import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { getCatalogEntriesByHashes, scopeCatalogEntriesForAccess } from "@/lib/catalog";
import { getCurrentUserId } from "@/lib/auth/permissions";
import { getCatalogCapability } from "@/lib/access/capabilities";
import { getPublishedVisibleEventIds } from "@/lib/catalog-events/visibility";
import { deriveEventTitle } from "@/lib/catalog-events/utils";
import { getLabsPreferenceForUser, isFeatureEnabledForUser } from "@/lib/features/capabilities";
import { TimestampIdParamSchema } from "@/lib/validation/schemas";
import { validateParams, notFound, forbidden, unauthorized } from "@/lib/api";
import type { RandomEventResponse } from "@/types/api";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Event metadata shown in the radio banner. The radio is event-oriented: the
 * banner's title, date, and location come from the CatalogEvent, while the
 * primary recording supplies only the audio (hash + duration).
 */
interface RadioEvent {
  eventId: number;
  title: string | null;
  dateYear: number;
  dateMonth: number | null;
  dateDay: number | null;
  locationName: string;
}

/**
 * Candidate pool for radio mode, keyed by the primary recording's hash: every
 * released, listener-visible event in the catalog. `getPublishedVisibleEventIds`
 * is the single source of truth for event visibility (released events whose
 * primary recording is published and actionable), so the returned hashes are
 * guaranteed streamable. Each entry carries the event metadata the banner shows.
 */
async function loadReleasedEventsByPrimaryHash(
  catalogId: string
): Promise<Map<string, RadioEvent>> {
  const visibleEventIds = await getPublishedVisibleEventIds(prisma, catalogId);
  if (visibleEventIds.length === 0) {
    return new Map();
  }

  const events = await prisma.catalogEvent.findMany({
    where: { id: { in: visibleEventIds }, workflowGroupId: catalogId },
    select: {
      id: true,
      title: true,
      dateYear: true,
      dateMonth: true,
      dateDay: true,
      location: { select: { name: true } },
      recordings: {
        where: { isPrimary: true },
        take: 1,
        select: { audioHash: true },
      },
    },
  });

  const eventsByPrimaryHash = new Map<string, RadioEvent>();
  for (const event of events) {
    const primaryHash = event.recordings[0]?.audioHash;
    if (!primaryHash) continue;
    eventsByPrimaryHash.set(primaryHash, {
      eventId: event.id,
      title: event.title,
      dateYear: event.dateYear,
      dateMonth: event.dateMonth,
      dateDay: event.dateDay,
      locationName: event.location.name,
    });
  }
  return eventsByPrimaryHash;
}

/**
 * GET /api/catalogs/:id/random-event - Get the next event primary to play
 *
 * Query params:
 * - exclude: Comma-separated list of hashes to exclude (play history)
 *
 * Radio mode follows events: the pool is the primary recording of each released,
 * listener-visible event (one primary per event), not the whole catalog.
 * If all candidates are excluded, resets and returns any candidate. Returns
 * { hash: null } when the catalog has no released events to play.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const paramsResult = validateParams(await params, TimestampIdParamSchema);
  if (!paramsResult.success) return paramsResult.response;
  const { id: catalogId } = paramsResult.data;

  // Check user access
  const userId = await getCurrentUserId();
  if (!userId) {
    return unauthorized();
  }
  const capability = await getCatalogCapability(catalogId, userId);
  if (!capability.catalogExists) {
    return notFound("catalog");
  }
  if (!capability.hasAccess) {
    return forbidden("Access denied");
  }

  // Returned whenever there is nothing for the radio to play.
  const emptyResponse: RandomEventResponse = {
    hash: null,
    total: 0,
    historyReset: false,
  };

  // The radio is event-oriented and its banner links to the event page, so it
  // requires the same events feature those pages enforce. Catalog access
  // already covers the LISTENER+ requirement; the only remaining gap is the
  // feature flag, so check it here and play nothing when events are disabled
  // for this user (otherwise the banner's event link could be a dead end).
  const labsPreference = await getLabsPreferenceForUser(userId);
  if (!isFeatureEnabledForUser("events", labsPreference.enabled)) {
    return NextResponse.json(emptyResponse, { status: 200 });
  }

  // Parse exclude list from query params
  const { searchParams } = new URL(request.url);
  const excludeParam = searchParams.get("exclude");
  const excludeSet = new Set(
    excludeParam ? excludeParam.split(",").filter(Boolean) : []
  );

  // Radio follows events: restrict the pool to primary recordings of released,
  // listener-visible events. No released events -> nothing to play.
  const eventsByHash = await loadReleasedEventsByPrimaryHash(catalogId);
  if (eventsByHash.size === 0) {
    return NextResponse.json(emptyResponse, { status: 200 });
  }

  // The pool is exactly the event primaries, so fetch only those catalog
  // entries instead of the whole catalog. getPublishedVisibleEventIds already
  // requires each primary to be actionable + published, but re-check
  // isActionable here too: access scoping only enforces it for LISTENER, and a
  // primary could flip to non-actionable between the two reads.
  const entries = await getCatalogEntriesByHashes(catalogId, [
    ...eventsByHash.keys(),
  ]);
  const playableEntries = scopeCatalogEntriesForAccess(
    entries,
    capability.accessLevel
  ).filter((entry) => entry.isActionable);

  if (playableEntries.length === 0) {
    return NextResponse.json(emptyResponse, { status: 200 });
  }

  // Filter out excluded entries
  let availableEntries = playableEntries.filter((e) => !excludeSet.has(e.hash));
  let historyReset = false;

  // If all entries are excluded, reset and use all playable entries
  if (availableEntries.length === 0) {
    availableEntries = playableEntries;
    historyReset = true;
  }

  // Pick a random entry. The banner metadata comes from the event; the
  // recording supplies only the audio (hash) and its duration.
  const randomIndex = Math.floor(Math.random() * availableEntries.length);
  const entry = availableEntries[randomIndex];
  // Present because the pool was filtered to hashes in eventsByHash.
  const event = eventsByHash.get(entry.hash)!;

  const responseBody: RandomEventResponse = {
    hash: entry.hash,
    eventId: event.eventId,
    title:
      event.title ||
      deriveEventTitle(
        event.locationName,
        event.dateYear,
        event.dateMonth,
        event.dateDay
      ),
    duration: entry.duration,
    dateYear: event.dateYear,
    dateMonth: event.dateMonth,
    dateDay: event.dateDay,
    locationName: event.locationName,
    total: playableEntries.length,
    historyReset,
  };
  return NextResponse.json(responseBody);
}
