# Offline Mode

## Status and intent

This document defines the target offline experience and the boundary that
supports it. The product model below is implemented on the page side: normal
pages render downloaded events from local packages, the session-free shell
serves them at their normal URLs, and the header carries the single
connectivity indicator. The audio transport underneath is the legacy chunk
store described under Current implementation; its replacement is specified by
#163.

The [current implementation](#current-implementation) section records what
is in production today as an operational fact. The remaining sections are the
specification the implementation is held to.

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

## Current implementation

Today, offline support is a device-local Downloads library plus a local-mode
bootstrap for the normal pages. A user downloads an event or recording while
online. Without a connection, the service worker answers any failed
application navigation with the cached session-free `/downloads` document at
the requested URL, and that document renders the Downloads library, a
catalog's downloaded events through the normal list component, or the normal
event and recording pages from local packages. Opening a download from
Downloads navigates to the normal event or recording URL. An already-open
normal event or recording page keeps playing a downloaded selected recording
after connectivity drops.

The normal event and recording pages already contain the first half of the
content-source seam. Their data queries call the API first and, when the
request itself cannot be made, read the same shapes from a complete local
package through `web/src/lib/offline/local-source.ts`: event detail, recording
entry with package-derived capabilities, and the stored transcript and
diarization. Audio prefers a complete local package even while online when it
matches the selected source; the local source URL carries a `local=1` marker
that the worker and server ignore, so the browser treats the switch to local
playback as a new media resource rather than resuming a network stream that
may have died, and the player carries position and play intent across that
switch. Playback progress made without a reachable server is queued for the
downloading account and synchronised on reconnect.

This is the legacy path that remains supported until the target architecture is
implemented and rolled out. Its data and transport behavior are as follows.

### Local data and caches

The `besedy-offline` IndexedDB database currently has three stores:

- `downloads` is the lightweight registry and source of truth for state,
  progress, byte counts, selected audio URL, event/recording snapshots, and
  download status.
- `downloadBundles` holds large optional payloads: the default transcript and
  diarization when permitted, published artwork, the event-detail and
  recording-entry payloads the shared pages render from, and a
  WebKit-compatible inline audio copy where required by that platform fallback.
- `pendingPlaybackProgress` retains local playback changes for later account
  synchronisation.

Audio is written in 2 MiB chunks to Cache Storage (`besedy-audio-v5`). A
metadata entry records size, MIME type, chunk sizes, and completion state; the
service worker streams valid byte ranges from complete chunks without joining a
recording in memory. The remaining caches are intentionally small:

- `besedy-offline-shell-v1` stores the session-free `/downloads` document.
- `besedy-offline-static-v1` stores up to 96 content-hashed Next.js assets
  requested by that Downloads root, plus app icons and the web manifest.

Normal application HTML and API JSON are not placed in an offline cache.

### Diagnosing the local transport on a device

A complete local recording reaches the media element in one of two ways: the
service worker answers Range requests from the chunked cache (`worker`), or the
player loads a Base64 data URL built from the inline copy stored with the
download (`inline`). The browser default comes from
`requiresInlineOfflineAudio` (WebKit on iOS and macOS, and Android browsers).
That default was chosen on emulator evidence only, so the player's debug panel
(the bug icon under the controls) shows the source kind the element was handed,
the requested transport, the browser default, whether a worker controls the
page, and an `auto | worker | inline` override. The two can differ: `inline`
requested without a stored inline copy is served from the worker cache, and
the Source line is the one that tells the truth. The override is stored in
`localStorage` under `besedy:offline-audio-transport` on that device alone; no
other user or device is affected, and `auto` removes it. To test a phone: set
`worker`, open a downloaded recording, switch to airplane mode, play and seek,
then read the event log in the same panel.

### Download manager and lifecycle

`web/src/lib/offline/download-manager.ts` owns downloads in the page because
idle service workers are not reliable owners of long mobile transfers. It
selects an audio source, writes resumable Range chunks, persists progress after
each chunk, stores permitted transcript/diarization and artwork payloads, and
requires a controlling service worker before reporting a cache-backed download
complete.

On hydration the manager verifies every completed package against Cache
Storage: the metadata entry must be complete and every chunk present. Where
`requiresInlineOfflineAudio` holds, the bundle must also hold the inline copy;
while online, hydration first builds a missing copy from the cached chunks, so
only packages that cannot get one are affected. A record
that fails this check, or cannot be checked because the cache is unreadable,
is not shown as downloaded; it becomes a retryable error with the message that
the audio is incomplete on this device, and Retry resumes the download from
the longest contiguous prefix of chunks that survived. Registry state alone
never proves playability. The header's Downloads badge counts only completed
packages, i.e. what verified as playable when the page loaded; the check is not
repeated while the page stays open.

One queued download runs at a time. A global Web Lock prevents queue ownership
in two tabs, a per-download lock prevents concurrent mutation of one record,
and a BroadcastChannel shares registry changes and abort requests. The manager
requests persistent storage before the first download. User-paused downloads
resume on demand; network-paused downloads resume after reconnection; a
download interrupted by page close returns to `queued` at hydration.

On startup and reconnect, the manager rechecks completed packages for the
signed-in account. If the account no longer has transcript-download
permission, it removes the stored transcript and diarization while retaining
audio and artwork; packages written before the event-detail and entry payloads
were stored receive them. This best-effort revocation cannot remove data from a device
that remains offline; temporary network or authentication failures are not
treated as permission decisions. Signing out deletes the database and
protected audio/shell caches.

### Local-mode shell and worker

`/downloads` has a session-free Next.js root layout that renders the shared
Header and `LocalModeShell`. The shell reads the document URL after hydration
and renders Downloads, `LocalEventList` for `/catalog/{id}`, `EventDetail` for
an event URL, or `RecordingContent` for a recording URL; any other URL gets a
non-blocking "not available offline" state. `LocalEventList` keeps the normal
catalog heading with an offline scope note: it lists downloaded events only,
while recording-only downloads remain in Downloads. The shared pages are imported
statically so their chunks belong to this document. After the first completed
download, the manager warms the document's HTML and asset graph through a
hidden `?warm=1` frame; a normal online visit refreshes it. Navigation between
local pages is ordinary Next.js navigation: when the data fetch fails, Next
falls back to a full navigation, which the worker answers with this document
again. The former `?item=<download-key>` selection, the separate
`OfflineDownloadDetail` renderer, and the fixed offline banner have been
removed; the header's crossed-Wi-Fi indicator links to Downloads and is the
only connectivity cue. In the shell the Header renders after hydration, and
while the session is unknown (offline without a session, or the client
session request still pending) it shows neither sign-in nor the signed-out
appearance toggles. When the connection returns, the shell requests the
session again so the header shows the signed-in account without a full
navigation.

A worker from before this shell answers a failed navigation with a redirect to
`/downloads?from=<original URL>`. Until the new worker is applied through the
update banner, the shell honours that `from` URL when it is same-origin: it
restores path and search with `history.replaceState`, lets the router re-read
the URL, and then renders the requested page from local packages with its
query parameters intact. This is what makes downloads made before a deploy
usable offline during the update window.

`web/public/sw.js` serves complete downloaded audio first, serves `/downloads`
network-first with a cached-shell fallback, and answers other failed app
navigations with that cached document at the requested URL, marked with the
`x-besedy-offline` header. It cache-serves existing Downloads static assets,
handles manifest/app-icon fallback, and leaves API requests alone. It also
retains the web-update, push-notification, and notification-click protocols.

## Target user experience

### Connectivity indicator

Offline state is represented by a crossed-Wi-Fi icon in the persistent app
menubar. It is visible on desktop and mobile, has an accessible offline label,
and is the single app-level connectivity indicator. It may open the local
downloads view, but it must not obscure content or interrupt playback.
The session-free local-mode bootstrap must render this same Header without a
server session, so the indicator is also present after an offline reload or
cold start.

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

The transcript is part of that parity. The shared transcript component renders
the locally retained default transcript exactly as it does online: the same
segments, timestamps, speaker labels when diarization is stored, and
click-to-seek into the player. Only actions that need the server, such as
transcript search or re-fetching another transcript, are omitted. There is no
separate offline transcript renderer and no reduced offline transcript mode.

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
| Persistent app menubar/header | Add a crossed-Wi-Fi icon while offline on both desktop and mobile; provide an accessible label. Render the same Header in the session-free local bootstrap. | Becomes the single app-level connectivity indicator and an optional entry point to local downloads. It never blocks the page or playback, including after an offline reload or cold start. |
| Fixed offline banner/overlay | Remove it entirely. | Remove its redirect-style “view downloads” recovery path; connection loss is communicated by the menubar icon instead. |
| Downloads entry and library | Retain the Downloads entry; present it as a library/management surface, not as a replacement app. | Continue to list all packages and provide progress, retry, remove, and storage management. Opening an event delegates to the shared event page. |
| Event cards (desktop and mobile) | Show the same downloaded marker, artwork, title, and playback affordances at every breakpoint. | Determine the marker from the durable completed package identity. Offline cards represent only locally available events. |
| Normal event list | Reuse the normal list and cards; add a concise “Downloaded events” scope indication when local data is being shown. | Read the local collection when network data is unavailable, so a person can select and switch downloaded events offline. |
| Normal event page | Preserve its information hierarchy and core components for local events; do not use a visually reduced offline page. | Resolve through the local source when necessary and adapt or omit only actions that require server data or a non-downloaded recording. |
| Audio player | Keep the usual player controls and optionally identify local availability without introducing a new visible player. | Continue active playback across connection loss and start, seek, and resume a complete downloaded recording without exposing local storage details to the UI. |
| Transcript panel | Render the shared transcript component unchanged; no reduced offline mode. | Display the locally retained permitted default transcript with the same timestamps, speaker labels, and click-to-seek as online; omit only server-backed actions such as transcript search. |
| Event artwork | Use the same published artwork placement, styling, and no-artwork fallback as the normal event page. | Resolve published artwork from the local package when offline; an event with no published artwork remains downloadable. |
| Current `OfflineDownloadDetail` | Retire the separate reduced detail frame, badges, and bespoke layout after migration. | Replace it with navigation to the shared event page; it no longer owns playback or transcript rendering. |
| Offline-unavailable state | Provide a clear, non-blocking empty/unavailable state for events without a completed package. | Do not expose a false play action or attempt a server-only page when no local source can satisfy it. |

### Non-UI elements

| Element | Required change |
| --- | --- |
| Shared event/list models | Define source-neutral event-page and event-collection models plus explicit capabilities. Components receive these models rather than API, IndexedDB, cache, or player-engine records directly. |
| Content-source seam | Implement online and local sources behind the same contract. The online source reads current API data; the local source reads only completed event packages. |
| Source selection | Page data comes from the server whenever the document or data request succeeds; the local source is used when that request fails and a complete local package exists. Audio prefers a complete local package even while online, because it is the same bytes by hash and avoids the online-to-offline transition as a special case. Do not use `navigator.onLine` as the sole decision because it does not prove a request will succeed. |
| Routing and application shell | Cache a session-free local-mode bootstrap that can start after a reload or browser/PWA restart without changing the requested normal event/list URL. It must render the shared Header without a session, render the shared presentation, and let the client content source resolve the URL; Downloads navigation routes into the same presentation. |
| Download package schema | Store selected recording identity and every read-only display value required by the shared event-page and event-card models. Store published artwork and, when permitted, the default transcript together with its diarization, in the same shape the shared transcript component consumes online, with an explicit content-availability manifest. |
| Download completion and markers | Mark an event complete only after the local playback implementation loads its package, reaches metadata, performs a silent non-zero seek, and reaches `canplay` without calling `play()`. Required model data must be durable, and each conditional payload must be stored or authoritatively known to be unavailable or not permitted. Derive status from catalog/event identity and recording hash, with migration support for existing records. |
| Audio storage and transport | Keep media storage and online/local resolution behind a boundary that is invisible to pages and components. The worker or media layer transports local audio; neither decides product routing nor owns long-running downloads. |
| Permissions and lifecycle | Retain transcript content only when permitted, reconcile it after a successful reconnect, and delete user-owned packages and protected caches on sign-out. |
| Playback progress | Preserve local playback position while offline and synchronise it when the account reconnects, using the existing durable pending-progress mechanism. |
| Migration and cleanup | Migrate existing registry/bundle records where possible; retire the separate offline-detail implementation and fixed banner only after shared local pages are in use. |
| Test coverage | Add browser-level coverage for offline transition, offline cold start and reload, event switching, shared-page parity, marker visibility on mobile/desktop, transcript parity, events with and without artwork, permissions, and unavailable local content. |

## Offline event package

A completed event download is an atomic local event package for the purpose of
offline presentation. Atomic means that each required or conditional part has
reached a durable, known state; it does not mean that every event has artwork
or a transcript. The package contains only the material needed for the
experience above:

| Content | Offline behavior |
| --- | --- |
| Audio | The selected recording identity and a durable local playback package. Its cache, file, segment, or transport representation is private to the media layer. |
| Transcript | The default transcript and its diarization, when they exist and the user may retain them, in the same shape the online transcript viewer consumes. The offline transcript renders with timestamps, speaker labels, and click-to-seek exactly as online. |
| Artwork | The published event artwork used by the normal event page when one exists. A package records the no-artwork state otherwise so the shared page can render its normal fallback. |
| Event and recording metadata | Every read-only display value required to construct the shared event-page and event-card models. At minimum this includes catalog and event identity, catalog label, event title and description, date, location, session ordering, and the selected recording's hash, title, artist, duration, and recorder. |
| Availability manifest | The playback-package format/version and whether conditional artwork and transcript content is stored, unavailable, or not permitted. The local source uses this state to derive capabilities instead of treating a missing value as a completed fetch. |

An event is marked downloaded only after its local playback implementation can
load the complete package, reach metadata, silently seek to a non-zero
position, and reach `canplay` without calling `play()`. Its required model data
must be durable, and every conditional part must be stored or authoritatively
known to be unavailable or not permitted. File presence or registry state alone
does not prove playability. If the online event model advertises artwork or a
permitted transcript but retrieving it fails, the download remains incomplete
and can be retried; a transient failure must not be recorded as absence. The
downloaded state is derived from durable local identity (catalog/event key and
selected recording hash), rather than a stale event-card snapshot. The same
state is rendered on desktop and mobile event cards.

The package excludes non-downloaded recordings and other server-backed event
data. It does not strip the transcript down to plain text: the transcript
payload is the same one the online viewer uses, so the shared component needs
no offline-specific mode and the current bundle contents remain valid.

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

Source selection follows the request, not `navigator.onLine`. When the
document or data request for a page succeeds, the page renders server data, so
an online page is always current. When that request fails, the session-free
bootstrap or the open page asks the local source for a complete package at the
same URL and renders it through the same components. Audio is the exception
and prefers a complete local package even while online: the bytes are identical
by hash, playback starts without the network, and the online-to-offline
transition stops being a special case for the player. Presentation components
never see URLs, manifests, segments, caches, or player engines.

The source returns explicit capabilities (for example, `canPlay`,
`hasTranscript`, and `canManageDownload`) together with the model. The local
source derives them from the durable package and its availability manifest;
it does not persist a stale copy of online authority. Shared event/list
components use those capabilities to show valid actions; they must not infer
offline behavior from the current route or duplicate presentation in an
`OfflineDownloadDetail` component. The service worker remains a possible
transport for local media and app assets, not the owner of product routing or
page data.

This seam is also the migration boundary:

1. Define the shared event and event-list models and capability contract.
2. Make the current normal pages consume the online source through that
   contract.
3. Build the local source from completed event packages and render it through
   the same pages/components.
4. Make Downloads link to those shared pages, then retire the separate offline
   detail renderer and the fixed offline banner.

Transport, media-engine selection, package versioning, and their rollout are
specified by [#163](https://github.com/lukleh/besedy/issues/163). This document
requires only that every supported transport serve the same source-neutral
models and visible player, without deepening dependencies on the temporary
offline-detail page.

## Storage boundary

The local event package and its availability manifest are stored durably, and
the minimal app assets needed for the local experience are cached. Those assets
include a session-free local-mode bootstrap that can start the shared
event/list presentation after a reload or browser/PWA restart while offline. A
download may be reported complete only after the non-playing readiness check
defined above succeeds against its durable local package.

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
every supported local representation.

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
- Verify download readiness without a user gesture: load the local package,
  wait for metadata, perform a silent non-zero seek, and reach `canplay`
  without calling `play()` or emitting audio.
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
  the offline transcript renders the same segments, timestamps, speaker labels,
  and click-to-seek as the online page, and that the artwork is present.
- Download an event with no published artwork and verify that it reaches the
  complete state and the shared page renders its normal no-artwork fallback.
- Verify that an event without a completed local package exposes no false
  offline-playback affordance.
