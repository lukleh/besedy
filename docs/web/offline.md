# Offline Mode

Besedy's offline mode is a device-local Downloads library, similar to a
podcast app. A user explicitly downloads an event or recording while online,
then opens it from `/downloads` without a connection. Catalog, event, and
recording pages remain online-only.

This deliberately avoids mirroring server-rendered pages and API responses.
Those pages depend on the current session and changing server data, while the
Downloads library needs only a small, stable playback model.

## Stored data

A download is identified by `catalogId` and audio hash. An event download uses
the event's primary recording and includes an event snapshot.

The `besedy-offline` IndexedDB database has two stores:

- `downloads` contains lightweight registry rows: state, progress, byte counts,
  the selected audio URL, and small event/recording snapshots. This is the
  source of truth for the Downloads list and download status.
- `downloadBundles` contains the larger optional payloads used by the offline
  detail view: the default transcript, diarization, and one poster Blob. Keeping
  these separate means progress updates and list reads do not copy transcripts
  or posters.

Audio is stored in 2 MB chunks in Cache Storage (`besedy-audio-v5`), with a
metadata entry that records the size, MIME type, chunks, and completion state.
Only a complete download can be served to the player.

The remaining caches are intentionally small:

- `besedy-offline-shell-v1` contains one HTML document, keyed as `/downloads`.
- `besedy-offline-static-v1` contains at most 96 content-hashed Next.js assets
  requested by Downloads, plus app icons and the web manifest.

Normal application HTML and API JSON are never put in an offline cache.

## Download engine

`web/src/lib/offline/download-manager.ts` runs downloads in the page. Service
workers may be terminated while idle, so they are not reliable owners of long
mobile downloads. The worker only reads completed audio.

The manager:

1. Fetches recording/event metadata and selects the audio source.
2. Downloads Range chunks directly to Cache Storage, persisting progress after
   each chunk so an interrupted download can resume.
3. Stores the default transcript, optional diarization, and one event poster in
   the IndexedDB bundle.

Only one queued download runs at a time. A global Web Lock prevents two tabs
from processing the queue concurrently, and a per-download lock prevents one
tab from removing data while another is writing it. A BroadcastChannel shares
registry changes and abort requests, so pause and remove also stop work owned
by another tab.

The manager asks for persistent browser storage before the first download.
User-paused downloads resume on demand. Downloads paused by a network failure
are tagged separately and resume when the browser reports that it is back
online. A download interrupted by a page close is changed from `downloading`
to `queued` when the registry is next hydrated.

## Session-free Downloads route

`/downloads` is under its own Next.js route-group root layout. That layout does
not read the server session, so the cached HTML document can start offline. The
online proxy still protects the route normally.

The route is client-rendered from the local registry. After the first download
completes, the manager loads the real Downloads route in a hidden frame so its
HTML and content-hashed build graph are cached without scraping or synthesizing
framework assets. An ordinary online visit refreshes the same shell.
Only the `?warm=1` response permits same-origin framing; the normal Downloads
response and every other page retain the global framing denial.
Selecting a download uses `?item=<download-key>` in the current document rather
than a server navigation. The detail view reuses the normal audio player and
transcript renderer, but supplies them with the downloaded audio URL and
IndexedDB payload.

The normal application uses a separate root layout because it still needs the
server session. This split is why the Downloads shell can be cached safely
without pretending that authenticated catalog pages are static.

## Service worker (`web/public/sw.js`)

The worker handles requests in this order:

| Request                      | Strategy                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Downloaded audio             | Serve byte ranges from complete cached chunks, streaming one chunk at a time; otherwise use the network. `?download=true` is never intercepted.    |
| `/downloads` navigation      | Network-first and refresh the one cached shell. On a network error, return the cached shell with `x-besedy-offline: 1`.                            |
| Other application navigation | Network-only. On a network error, redirect to `/downloads?from=<original path>` if the shell exists; otherwise return a small inline offline page. |
| `/_next/static/*`            | Cache-first for existing entries. New entries are cached only when requested by Downloads, with a 96-entry limit.                                  |
| Manifest and app icons       | Network-first with cache fallback.                                                                                                                 |
| API and other requests       | Not intercepted.                                                                                                                                   |

Range parsing is strict: unsupported multiple ranges and invalid or reversed
ranges return `416`. Audio is streamed from the chunk cache without joining the
whole file in memory.

The worker also retains the existing web-update handshake, push notifications,
and notification-click behavior. Activating a new worker deletes obsolete
Besedy cache versions.

## User-visible behavior

Offline mode supports:

- opening the Downloads library;
- listing device-local downloads;
- opening a downloaded event or recording from that list;
- audio playback and seeking;
- the downloaded default transcript and diarization; and
- locally saved playback position.

Offline mode does not support catalog/event lists, normal event or recording
pages, search, edits, fresh access checks, or other API-backed features—even if
the item was downloaded. A failed navigation to one of those pages redirects to
Downloads. This is an intentional product boundary, not a cache miss.

Signing out deletes the downloads database and protected audio/shell caches.
The static asset cache is not user-specific.

## Platform notes and troubleshooting

- Service workers require HTTPS or `localhost`; plain `http://<LAN-IP>` does
  not support this mode.
- Safari may evict site storage after seven days without use unless the app is
  installed to the home screen.
- Background Fetch and periodic sync are not used. Downloads run while an app
  page is open.
- To reset offline data, use DevTools → Application → Storage → Clear site data.
- If Downloads cannot open offline, complete a download or visit it online and
  check `besedy-offline-shell-v1` plus `besedy-offline-static-v1`.
- If playback fails for a complete record, inspect its metadata and chunks in
  `besedy-audio-v5`; removing and downloading it again rebuilds them.
