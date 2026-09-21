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
transition, the player selects the locally stored audio before attempting the
network. The same rule applies whether the person arrived from the normal list
or Downloads.

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
| Audio player | Keep the usual player controls and optionally identify local availability without introducing a new player. | Continue active playback across connection loss; start, seek, and resume a downloaded recording from cached range-served audio. |
| Transcript panel | Render a plain, readable transcript; remove speaker/diarization controls, timestamps, and transcript-driven seek affordances in local mode. | Display the locally retained permitted default transcript without time synchronisation. |
| Event artwork | Use the same published artwork placement, styling, and no-artwork fallback as the normal event page. | Resolve published artwork from the local package when offline; an event with no published artwork remains downloadable. |
| Current `OfflineDownloadDetail` | Retire the separate reduced detail frame, badges, and bespoke layout after migration. | Replace it with navigation to the shared event page; it no longer owns playback or transcript rendering. |
| Offline-unavailable state | Provide a clear, non-blocking empty/unavailable state for events without a completed package. | Do not expose a false play action or attempt a server-only page when no local source can satisfy it. |

### Non-UI elements

| Element | Required change |
| --- | --- |
| Shared event/list models | Define source-neutral event-page and event-collection models plus explicit capabilities. Components receive these models rather than API or IndexedDB records directly. |
| Content-source seam | Implement online and local sources behind the same contract. The online source reads current API data; the local source reads only completed event packages. |
| Source selection | Prefer current online data when it can be obtained, then fall back to a complete local package. Do not use `navigator.onLine` as the sole decision because it does not prove a request will succeed. |
| Routing and application shell | Cache a session-free local-mode bootstrap that can start after a reload or browser/PWA restart without changing the requested normal event/list URL. The bootstrap renders the shared presentation and lets the client content source resolve the URL; Downloads navigation routes into the same presentation. |
| Download package schema | Store the selected audio and every read-only display value required by the shared event-page and event-card models. Store published artwork and a permitted plain transcript conditionally, with an explicit content-availability manifest. Remove diarization and timestamp-dependent transcript payloads from the offline contract. |
| Download completion and markers | Mark an event complete only when the exact cached audio source is range-servable, required model data is durable, and each conditional payload is either stored or authoritatively known to be unavailable or not permitted. Derive status from catalog/event identity and recording hash, with migration support for existing records. |
| Audio cache and service worker | Keep resumable chunk storage and strict range serving. The worker serves complete local audio; it does not decide product routing or own long-running downloads. |
| Permissions and lifecycle | Retain transcript content only when permitted, reconcile it after a successful reconnect, and delete user-owned packages and protected caches on sign-out. |
| Playback progress | Preserve local playback position while offline and synchronise it when the account reconnects, using the existing durable pending-progress mechanism. |
| Migration and cleanup | Migrate existing registry/bundle records where possible; retire the separate offline-detail implementation and fixed banner only after shared local pages are in use. |
| Test coverage | Add browser-level coverage for offline transition, offline cold start and reload, event switching, shared-page parity, marker visibility on mobile/desktop, plain transcripts, events with and without artwork, permissions, and unavailable local content. |

## Offline event package

A completed event download is an atomic local event package for the purpose of
offline presentation. Atomic means that each required or conditional part has
reached a durable, known state; it does not mean that every event has artwork
or a transcript. The package contains only the material needed for the
experience above:

| Content | Offline behavior |
| --- | --- |
| Audio | The selected event recording, stored in chunks and served with range support so playback and seeking work offline. |
| Transcript | The default transcript as plain readable text when one exists and the user may retain it. Offline transcript view has no diarization, timestamps, speaker controls, or time-synchronised seeking. |
| Artwork | The published event artwork used by the normal event page when one exists. A package records the no-artwork state otherwise so the shared page can render its normal fallback. |
| Event and recording metadata | Every read-only display value required to construct the shared event-page and event-card models. At minimum this includes catalog and event identity, catalog label, event title and description, date, location, session ordering, and the selected recording's hash, title, artist, duration, and recorder. |
| Availability manifest | Whether conditional artwork and transcript content is stored, unavailable, or not permitted. The local source uses this state to derive capabilities instead of treating a missing value as a completed fetch. |

An event is marked downloaded only after its audio is range-servable, its
required model data is durable, and every conditional part is either stored or
authoritatively known to be unavailable or not permitted. If the online event
model advertises artwork or a permitted transcript but retrieving it fails,
the download remains incomplete and can be retried; a transient failure must
not be recorded as absence. The downloaded state is derived from durable local
identity (catalog/event key and selected recording hash), rather than a stale
event-card snapshot. The same state is rendered on desktop and mobile event
cards.

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
likewise chooses the locally cached URL for a downloaded recording on network
failure. This covers the important online-to-offline transition, where a page
is already open and `navigator.onLine` alone is not a reliable statement about
whether a request can succeed.

The source returns explicit capabilities (for example, `canPlay`,
`hasTranscript`, and `canManageDownload`) together with the model. The local
source derives them from the durable package and its availability manifest;
it does not persist a stale copy of online authority. Shared event/list
components use those capabilities to show valid actions; they must not infer
offline behavior from the current route or duplicate presentation in an
`OfflineDownloadDetail` component. The service worker remains a transport
mechanism for cached audio and app assets, not the owner of product routing or
page data.

This seam is also the migration boundary:

1. Define the shared event and event-list models and capability contract.
2. Make the current normal pages consume the online source through that
   contract.
3. Build the local source from completed event packages and render it through
   the same pages/components.
4. Make Downloads link to those shared pages, then retire the separate offline
   detail renderer and the fixed offline banner.

The current bug-fix work remains intentionally narrower: it makes the existing
downloaded audio playable and fixes downloaded markers. It does not claim to
implement this migration.

## Storage and transport

The download manager runs in the page, writes audio in resumable chunks to
Cache Storage, and stores the local event package in IndexedDB. A service
worker serves byte ranges from complete cached audio and caches the minimal app
assets needed for the local experience. Those assets include a session-free
local-mode bootstrap that can start the shared event/list presentation after a
reload or browser/PWA restart while offline. A download may be reported
complete only once the service worker can serve its exact saved audio URL
offline.

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
Signing out deletes user-owned local packages and protected audio caches.

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
