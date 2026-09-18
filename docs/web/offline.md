# Offline Mode

The web app works offline the way a podcast app does: the user downloads an
event (or a single recording), and from then on it can be opened and played
without a connection. Everything else stays network-first. This document is
the source of truth for how that works; `docs/web/architecture.md` only links
here.

## Model

- **Download unit:** a recording (`catalogId` + audio hash). An event download
  is the download of the event's primary recording with the event attached, so
  the events list, the event page, and the recording page all agree on what is
  downloaded.
- **Registry:** one IndexedDB record per download in the `besedy-offline`
  database, store `downloads` (`web/src/lib/offline/downloads-db.ts`). The
  record carries status, progress, size, and small snapshots of the event and
  recording for the Downloads page. It is the only source of truth for "is this
  downloaded"; the UI never scans Cache Storage to find out.
- **Bundle:** everything the event or recording page needs to render and play
  offline:
  - audio, stored as 2 MB chunks in Cache Storage (`besedy-audio-v5`);
  - the JSON responses the page requests (entry, audio sources, source
    preference, playback progress, event detail, transcript backends, the
    default transcript, formats, diarization) in `besedy-data-v1`, keyed by the
    exact request URL;
  - the event posters, also in `besedy-data-v1`;
  - the page HTML in `besedy-shell-v1`, keyed by pathname, plus every
    `/_next/static/` asset the HTML and its stylesheets reference in
    `besedy-static-v1`.
- **Download engine:** runs in the page, not in the service worker
  (`web/src/lib/offline/download-manager.ts`). Service workers are terminated
  after a short idle period, which is what made the old worker-driven download
  flaky on phones. The page fetches Range chunks and writes them straight into
  Cache Storage; the worker only reads. One download runs at a time, the queue
  and progress are persisted per chunk, interrupted downloads resume from the
  last stored chunk, and a Web Lock keeps two tabs from running the queue at
  once.

## Service worker (`web/public/sw.js`)

The worker is read-only with respect to downloads. Its routing, in order:

| Request | Strategy |
| --- | --- |
| `GET …/recordings/:hash/audio` | Serve Range requests from complete chunked cache; otherwise pass through. `?download=true` is never intercepted. |
| Navigation (except `/api/auth/*`, `/mock-oauth/*`) | Network-first with `cache: "no-store"`. A successful HTML response for a shell route is stored by pathname. On network failure: cached HTML for that pathname, else a redirect to `/downloads?from=<path>`, else a small inline offline page. |
| `/_next/static/*` | Cache-first (content-hashed, immutable). |
| `/manifest.webmanifest`, icons | Network-first, cache fallback. |
| Allow-listed `GET /api/*` JSON | Network-first. Successful JSON responses are stored; on network failure the stored response is returned with an `x-besedy-offline: 1` header. Non-2xx responses are never stored and never replaced by cache, so access revocation still fails closed while online. |
| Everything else | Not intercepted. |

Shell routes are `/catalog`, `/catalog/:id`, `/catalog/:id/event/:eventId`,
`/catalog/:id/recording/:hash`, and `/downloads`. The data allow-list lives at
the top of `sw.js` next to the cache names; the download manager relies on the
same URLs, so `tests/unit/service-worker-script.test.ts` checks the list.

The worker still handles the update handshake (`GET_WEB_VERSION`,
`SKIP_WAITING`), push notifications, and notification clicks. The download
message protocol from earlier versions is gone.

## Client

- `useDownloadManager()`, `useDownloadRecord()`, `useEventDownload()`, and
  `useDownloadedEvents()` in `web/src/hooks/use-downloads.ts` expose the
  registry through `useSyncExternalStore`.
- `DownloadManagerBridge` (mounted in `components/providers.tsx`) hydrates the
  registry, resumes queued downloads when the browser comes back online,
  registers a `download` reload blocker so an app update cannot reload the tab
  mid-download, and warms the `/downloads` shell once per session.
- `DownloadButton` is the ring control shown in the player, on recording cards
  and table rows, and in the event header. Tapping starts a download, tapping
  again pauses it, and a paused or failed download resumes on tap.
- `/downloads` lists downloads grouped by catalog with progress, size, storage
  usage, and remove actions. When the worker redirects an offline navigation
  there, the page explains that the requested page is not available offline.
- The offline banner links to `/downloads`.
- Sign-out clears the audio, data, and shell caches and the downloads database
  in addition to the session.

## What to expect offline

Works: launching the installed app, opening a downloaded event or recording
from the Downloads page or from a cached list page, playback with seeking,
transcript reading for the default transcript backend, playback position
(saved locally and synced when back online).

Does not work: pages and lists that were never visited or downloaded, search,
edits and any other write, fresh access checks. Cached pages show the last
state seen online. Access changes take effect on the next online load, which is
the same trade-off native podcast apps make.

## Platform notes

- Service workers need HTTPS or `localhost`. Plain `http://<LAN-IP>` never
  registers one, so nothing here works there.
- Safari evicts all site storage after seven days without use unless the app
  is installed to the home screen. The install prompt matters for offline use.
- The manager calls `navigator.storage.persist()` before the first download so
  Chromium does not evict downloads under storage pressure.
- Background Fetch and periodic sync are not used; downloads run while the app
  is in the foreground.

## Troubleshooting

- Reset everything: DevTools → Application → Storage → Clear site data. The
  registry and all caches are rebuilt from scratch.
- A download stuck in "paused" with no error means the network dropped; it
  resumes on the next online event or on tap.
- If a downloaded page shows an error offline, check `besedy-shell-v1` for the
  pathname and `besedy-data-v1` for the JSON URLs listed above. Missing entries
  mean the download completed on an older build; remove and download again.
