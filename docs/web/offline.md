# Offline Mode

## Status and intent

This document defines the target offline experience and the boundary that will
support it. It is deliberately broader than the current implementation. The
current implementation has a device-local `/downloads` shell, a fixed offline
banner, and a separate reduced download-detail page. Those are transition
mechanisms, not the intended product model.

Offline is a first-class operating mode of Besedy, not an add-on, a separate
mini-app, or a feature that requires entering a special Downloads area. The
same Besedy navigation, event cards, event page, artwork, transcript, and
player continue to serve the person; only the source of available content and
the set of valid actions change.

The mode is user-centric: a person who prepared events while connected must be
able to keep listening when connectivity disappears and move between their
downloaded events without having to understand cache state, routes, or whether
they entered through a special part of the application. It is not a general
offline mirror of Besedy.

The product promise is:

1. A downloaded event remains playable when the device loses connectivity,
   including while it is already playing.
2. While offline, the person can find and switch among downloaded events.
3. Each downloaded event presents the familiar event page, using local content
   where necessary.

Everything else follows from that promise. Downloads is a supporting library
for managing local packages, not a replacement navigation system or a separate
offline product. The normal experience remains the primary experience in both
connectivity states.

## User experience

### Connectivity indicator

Offline state is represented by a crossed-Wi-Fi icon in the persistent app
menubar. It is visible on desktop and mobile, has an accessible offline label,
and is the single app-level connectivity indicator. It may open the local
downloads view, but it must not obscure content or interrupt playback.

The existing fixed offline banner/overlay is removed. Connection loss is a
state change, not an error dialog: a downloaded recording that is playing
continues, and the menubar icon tells the person why network-only actions are
unavailable.

### Finding and switching downloaded events

The normal event-list and event-detail experience is the primary way to use
downloaded content. When offline, the list shows the downloaded events that
are locally available in the current catalog; selecting one uses the normal
event route and event-page presentation. The list may make its reduced scope
explicit (for example, “Downloaded events”), but it must preserve the normal
card, title, artwork, and playback affordances. A person can therefore move
from one downloaded event to another in the same Besedy flow they use online.

The Downloads section remains a complementary library and management surface:
it can show all local downloads, progress, storage usage, retry, and remove
actions. Selecting an event there opens the same event page as selecting it
from the normal event list. It must not own a separate, visually reduced event
detail implementation.

### Event-page parity

An event opened from local data has the same information hierarchy and core
components as the normal event page. The page is clearly allowed to adapt
actions whose data or authority cannot exist offline: server-only edits,
search, fresh permission checks, and recordings that were not downloaded are
not offered as working offline actions. This is capability adaptation, not a
second offline-specific page.

If a normal event page is already open when connectivity disappears, playback
of a downloaded selected recording continues. If playback starts after the
transition, the player resolves a complete local playable asset before
attempting the network. The asset can use any supported, versioned media
transport; the page and visible player do not depend on its storage format.
The same rule applies whether the person arrived from the normal list or
Downloads.

## Change inventory

The following tables are the implementation scope for this target design. They
separate visible product changes from the supporting work so a future delivery
can be divided into reviewable slices without reintroducing a separate offline
application.

### Affected UI elements

| Element | Visual change | Behavioral change |
| --- | --- | --- |
| Persistent app menubar/header | Add a crossed-Wi-Fi icon while offline on both desktop and mobile; provide an accessible label. | Becomes the single app-level connectivity indicator and an optional entry point to local downloads. It never blocks the page or playback. |
| Fixed offline banner/overlay | Remove it entirely. | Remove its redirect-style “view downloads” recovery path; connection loss is communicated by the menubar icon instead. |
| Downloads entry and library | Retain the Downloads entry; present it as a library/management surface, not as a replacement app. | Continue to list all packages and provide progress, retry, remove, and storage management. Opening an event delegates to the shared event page. |
| Event cards (desktop and mobile) | Show the same downloaded marker, artwork, title, and playback affordances at every breakpoint. | Determine the marker from the durable completed package identity. Offline cards represent only locally available events. |
| Normal event list | Reuse the normal list and cards; add a concise “Downloaded events” scope indication when local data is being shown. | Read the local collection when network data is unavailable, so a person can select and switch downloaded events offline. |
| Normal event page | Preserve its information hierarchy and core components for local events; do not use a visually reduced offline page. | Resolve through the local source when necessary and adapt or omit only actions that require server data or a non-downloaded recording. |
| Audio player | Keep the usual player controls and optionally identify local availability without introducing a new visible player. | Resolve a versioned online or local playback descriptor through a media-engine adapter; continue active playback across connection loss and start, seek, and resume a complete downloaded recording without exposing the backing transport to the UI. |
| Transcript panel | Render a plain, readable transcript; remove speaker/diarization controls, timestamps, and transcript-driven seek affordances in local mode. | Display the locally retained permitted default transcript without time synchronisation. |
| Event artwork | Use the same published artwork placement, styling, and no-artwork fallback as the normal event page. | Resolve published artwork from the local package when offline; an event with no published artwork remains downloadable. |
| Current `OfflineDownloadDetail` | Retire the separate reduced detail frame, badges, and bespoke layout after migration. | Replace it with navigation to the shared event page; it no longer owns playback or transcript rendering. |
| Offline-unavailable state | Provide a clear, non-blocking empty/unavailable state for events without a completed package. | Do not expose a false play action or attempt a server-only page when no local source can satisfy it. |

### Non-UI elements

| Element | Required change |
| --- | --- |
| Shared event/list models | Define source-neutral event-page and event-collection models plus explicit capabilities and a storage-independent playback descriptor. Components receive these models rather than API, IndexedDB, cache, or player-engine records directly. |
| Content-source seam | Implement online and local sources behind the same contract. The online source reads current API data; the local source reads only completed event packages. |
| Source selection | Prefer current online data when it can be obtained, then fall back to a complete local package. Do not use `navigator.onLine` as the sole decision because it does not prove a request will succeed. |
| Routing and application shell | Cache a session-free local-mode bootstrap that can start after a reload or browser/PWA restart without changing the requested normal event/list URL. The bootstrap renders the shared presentation and lets the client content source resolve the URL; Downloads navigation routes into the same presentation. |
| Download package schema | Store the selected recording identity, a versioned playback-package descriptor, and every read-only display value required by the shared event-page and event-card models. Store published artwork and a permitted plain transcript conditionally, with an explicit content-availability manifest. Remove diarization and timestamp-dependent transcript payloads from the offline contract. |
| Download completion and markers | Mark an event complete only when the selected media engine can initialize, play, and seek its durable local playback package, required model data is durable, and each conditional payload is either stored or authoritatively known to be unavailable or not permitted. Derive status from catalog/event identity and recording hash, with migration support for existing records. |
| Audio storage and transport | Put resumable media storage and online/local resolution behind a versioned playback descriptor and media-engine adapter. Implementations must keep memory bounded relative to their segment/read window rather than recording duration. The service worker or player networking adapter transports local media; neither decides product routing nor owns long-running downloads. |
| Permissions and lifecycle | Retain transcript content only when permitted, reconcile it after a successful reconnect, and delete user-owned packages and protected caches on sign-out. |
| Playback progress | Preserve local playback position while offline and synchronise it when the account reconnects, using the existing durable pending-progress mechanism. |
| Migration and cleanup | Version playback packages so the legacy and replacement media engines can coexist during an opt-in rollout. Migrate existing registry/bundle records where possible; retire a legacy engine, the separate offline-detail implementation, and the fixed banner only after their replacements pass the physical-device matrix and rollback is no longer required. |
| Test coverage | Add browser-level coverage for offline transition, offline cold start and reload, event switching, shared-page parity, marker visibility on mobile/desktop, plain transcripts, events with and without artwork, permissions, unavailable local content, playback-package versions, bounded memory, and feature-flag rollback. |

## Offline event package

A completed event download is an atomic local event package for the purpose of
offline presentation. Atomic means that each required or conditional part has
reached a durable, known state; it does not mean that every event has artwork
or a transcript. The package contains only the material needed for the
experience above:

| Content | Offline behavior |
| --- | --- |
| Audio | The selected recording identity and a versioned local playback package that the chosen media engine can initialize, play, and seek with bounded memory. Its cache, file, segment, or transport representation is private to the media layer. |
| Transcript | The default transcript as plain readable text when one exists and the user may retain it. Offline transcript view has no diarization, timestamps, speaker controls, or time-synchronised seeking. |
| Artwork | The published event artwork used by the normal event page when one exists. A package records the no-artwork state otherwise so the shared page can render its normal fallback. |
| Event and recording metadata | Every read-only display value required to construct the shared event-page and event-card models. At minimum this includes catalog and event identity, catalog label, event title and description, date, location, session ordering, and the selected recording's hash, title, artist, duration, and recorder. |
| Availability manifest | The playback-package format/version and whether conditional artwork and transcript content is stored, unavailable, or not permitted. The local source uses this state to derive capabilities instead of treating a missing value as a completed fetch. |

An event is marked downloaded only after its selected media engine passes a
readiness check against the complete local playback package, its required model
data is durable, and every conditional part is either stored or authoritatively
known to be unavailable or not permitted. File presence or registry state alone
does not prove playability. If the online event model advertises artwork or a
permitted transcript but retrieving it fails, the download remains incomplete
and can be retried; a transient failure must not be recorded as absence. The
downloaded state is derived from durable local identity (catalog/event key and
selected recording hash), rather than a stale event-card snapshot. The same
state is rendered on desktop and mobile event cards.

The package deliberately excludes diarization and transcript timestamps. They
do not serve the offline listening task and would create a second, more complex
transcript experience. It also excludes non-downloaded recordings and other
server-backed event data.

Transcript download permission still applies. If no default transcript exists
or the user is not entitled to retain it, the availability manifest records
that state and the package can still complete without transcript content. On a
later successful connection, the app reconciles retained protected content
with the user’s current entitlement. This is best effort: a device that remains
offline necessarily retains its local package until it reconnects.

## The online/offline content seam

Online and offline are modes of the same pages, not two applications. They
meet at a content-source seam, rather than at independent page implementations
or service-worker routing rules. Presentation components consume an event-page
model and a collection model; they do not know whether those values came from
the API or from local storage.

The seam has two sources:

| Source | Responsibility |
| --- | --- |
| Online source | Retrieves current event data and permissions from the API and creates the normal event/list models. |
| Local source | Reads completed local event packages and creates the same models, with only the capabilities and content that the package provides. |

Source selection is resilient rather than relying solely on `navigator.onLine`:
the app attempts the online source where appropriate and falls back to a
complete local package when it cannot obtain network data. The audio resolver
likewise chooses an online or complete local playback descriptor without
requiring presentation components to understand URLs, manifests, segments,
caches, or player engines. This covers the important online-to-offline
transition, where a page is already open and `navigator.onLine` alone is not a
reliable statement about whether a request can succeed.

The source returns explicit capabilities (for example, `canPlay`,
`hasTranscript`, and `canManageDownload`) together with the model. The local
source derives them from the durable package and its availability manifest;
it does not persist a stale copy of online authority. Shared event/list
components use those capabilities to show valid actions; they must not infer
offline behavior from the current route or duplicate presentation in an
`OfflineDownloadDetail` component. Media transport belongs to a playback
adapter and its storage/networking implementation. The service worker remains
a possible transport for local media and app assets, not the owner of product
routing or page data.

This seam is also the migration boundary:

1. Define the shared event and event-list models, playback descriptor, and
   capability contract.
2. Make the current normal pages consume the online source through that
   contract.
3. Put the current and replacement media engines behind the same player adapter
   and select them by playback-package version and a reversible feature flag.
4. Build the local source from completed event packages and render it through
   the same pages/components.
5. Make Downloads link to those shared pages, then retire the separate offline
   detail renderer and the fixed offline banner.

Legacy and replacement playback paths may coexist during migration, but they
must share the visible player and source-neutral model. New transport work must
not deepen dependencies on the temporary offline-detail page. A legacy engine
is removed only after the replacement passes online and offline verification on
physical supported devices and the rollback window has ended.

## Media transport boundary and rollout

The event model exposes a playback descriptor rather than a raw assumption
about one URL or cache format. At minimum, that descriptor identifies the
recording, its transport/package version, and the information the matching
engine needs to resolve online or durable local media. Transient object or data
URLs are runtime details and are not durable event-package identity.

The visible player is shared. A media-engine adapter maps a descriptor to the
underlying implementation and exposes common play, pause, seek, duration,
buffer, playback-rate, volume, error, and lifecycle behavior. A replacement
engine may therefore be tested beside the current engine without duplicating
the player UI or changing the event page.

Rollout is reversible:

1. Add new indexing, storage, or transport infrastructure without changing the
   default player.
2. Enable the replacement engine for explicit testers and representative
   recordings through a runtime feature flag.
3. Version offline playback packages so existing downloads continue through
   their matching legacy engine while test downloads use the replacement.
4. Expand through a measured canary only after online playback succeeds.
5. Make the replacement the default for new downloads only after physical
   desktop and mobile offline tests pass.
6. Migrate or explicitly redownload legacy packages before removing their
   engine. Never reinterpret an old package as a new format based only on
   application version.

Only one playback package is stored for an ordinary user and recording. A
diagnostic comparison may retain both formats temporarily for an explicit
tester, but duplication is not the production model.

## Storage and transport

The download manager runs in the page and writes through a versioned offline
media-store interface because browsers may terminate idle service workers
during a long download. The implementation must persist resumable progress and
keep memory bounded for multi-hour recordings. Cache Storage chunks, virtual
segments, or a file-backed representation can coexist as separately versioned
package formats during migration; pages and presentation models do not depend
on that choice.

The local event package and its availability manifest are stored durably, and
the minimal app assets needed for the local experience are cached. Those assets
include a session-free local-mode bootstrap that can start the shared
event/list presentation after a reload or browser/PWA restart while offline. A
download may be reported complete only after its selected media engine can
initialize, play, and seek the exact durable local package. No completion path
may assemble or Base64-encode a complete multi-hour recording in JavaScript
memory.

When an application navigation cannot reach the server, the worker returns the
local-mode bootstrap as a transport fallback without changing the requested
normal URL. The bootstrap contains no session or event data; it passes the URL
to the client content-source seam, which either renders a complete local
package through the shared components or shows the offline-unavailable state.
This generic fallback does not make the worker the owner of product routing.

Normal online HTML and API JSON must not be blindly cached as an offline
mirror. The local source owns the small, explicit, permission-aware package
described above. This keeps offline behavior predictable, limits retained data,
and avoids treating a stale server-rendered document as an authenticated page.

Downloads run while an app page is open. They can resume after a network
interruption, but background fetch and periodic sync are not requirements.
Signing out deletes user-owned local packages and protected media storage for
every supported playback-package version.

## Out of scope

Offline mode does not promise a full offline catalog, global search, edits,
fresh access checks, administration, or arbitrary server navigation. An event
that was not downloaded must explain that it is unavailable offline rather than
showing an apparently functional page that fails on interaction. These limits
are compatible with seamless offline listening and event switching because the
local event collection contains the user’s downloaded events.

## Verification criteria for the implementation

- A downloaded marker is visible on the same event card on desktop and mobile.
- Start a downloaded recording online, disable connectivity, and verify that
  audio continues and seeking still works.
- Disable connectivity before pressing play on an already-open downloaded event
  and verify that it starts from local audio.
- Verify the same player controls and event-page presentation with every
  enabled media-engine implementation; the active engine is visible only in
  diagnostics, not as a second product UI.
- With a representative multi-hour recording, verify that download and
  playback memory remain bounded by the configured segment/read and playback
  buffer windows rather than growing with recording duration.
- Keep existing legacy downloads playable while the replacement engine is
  enabled for an explicit tester, then disable the feature flag and verify that
  the legacy path still works without migration or data loss.
- While offline, open the menubar indicator, reach downloaded events, and
  switch between at least two downloaded event pages without an API response.
- After completing those downloads, close every Besedy tab or terminate the
  installed PWA, disable connectivity, and reopen Besedy. Verify that the
  shared event list and both event pages load and playback starts without an
  API response.
- Reload a downloaded event at its normal event URL while offline and verify
  that the session-free local-mode bootstrap preserves the URL and renders the
  shared event page from its local package.
- Open the same event from Downloads and from the normal event list; verify
  that it uses the same event-page implementation and content hierarchy.
- For an event with a permitted transcript and published artwork, verify that
  the transcript has plain text only—no diarization, timestamps, speaker
  controls, or transcript-driven seeking—and that the artwork is present.
- Download an event with no published artwork and verify that it reaches the
  complete state and the shared page renders its normal no-artwork fallback.
- Verify that an event without a completed local package exposes no false
  offline-playback affordance.
