# Offline Mode

## Status and intent

This document defines the target offline experience and the boundary that will
support it. It is deliberately broader than the current implementation. The
current implementation has a device-local `/downloads` shell, a fixed offline
banner, and a separate reduced download-detail page. Those are transition
mechanisms, not the intended product model.

Offline mode is user-centric: a person who prepared events while connected
must be able to keep listening when connectivity disappears and move between
their downloaded events without having to understand cache state, routes, or
whether they entered through a special part of the application. It is not a
general offline mirror of Besedy.

The product promise is:

1. A downloaded event remains playable when the device loses connectivity,
   including while it is already playing.
2. While offline, the person can find and switch among downloaded events.
3. Each downloaded event presents the familiar event page, using local content
   where necessary.

Everything else follows from that promise. In particular, a Downloads section
is useful for managing downloaded content, but it must not be the only way to
continue listening or to change event while offline.

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
from one downloaded event to another in the same way they do online.

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

## Offline event package

A completed event download is an atomic local event package for the purpose of
offline presentation. It contains only the material needed for the experience
above:

| Content | Offline behavior |
| --- | --- |
| Audio | The selected event recording, stored in chunks and served with range support so playback and seeking work offline. |
| Transcript | The permitted default transcript as plain readable text. Offline transcript view has no diarization, timestamps, speaker controls, or time-synchronised seeking. |
| Artwork | The published event artwork used by the normal event page. |
| Event metadata | The stable title, date, location, session ordering, and recording identity needed to render a card and event page and to switch events. |

An event is marked downloaded only after every required part of its package is
available. The downloaded state must be derived from durable local identity
(catalog/event key and selected recording hash), rather than a stale event-card
snapshot. The same state is rendered on desktop and mobile event cards.

The package deliberately excludes diarization and transcript timestamps. They
do not serve the offline listening task and would create a second, more complex
transcript experience. It also excludes non-downloaded recordings and other
server-backed event data.

Transcript download permission still applies. If a user is not entitled to
retain a transcript, the package contains audio, artwork, and metadata but no
transcript. On a later successful connection, the app reconciles retained
protected content with the user’s current entitlement. This is best effort: a
device that remains offline necessarily retains its local package until it
reconnects.

## The online/offline content seam

Online and offline pages must meet at a content-source seam, not at two
independent page implementations or service-worker routing rules. Presentation
components consume an event-page model and a collection model; they do not
know whether those values came from the API or from local storage.

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
`hasTranscript`, and `canManageDownload`) together with the model. Shared
event/list components use those capabilities to show valid actions; they must
not infer offline behavior from the current route or duplicate presentation in
an `OfflineDownloadDetail` component. The service worker remains a transport
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
assets needed for the local experience. A download may be reported complete
only once the service worker can serve its exact saved audio URL offline.

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
- Open the same event from Downloads and from the normal event list; verify
  that it uses the same event-page implementation and content hierarchy.
- Verify that the offline transcript has plain text only—no diarization,
  timestamps, speaker controls, or transcript-driven seeking—and that artwork
  is present.
- Verify that an event without a completed local package exposes no false
  offline-playback affordance.
