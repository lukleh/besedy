# Web Application Architecture

> **Last Updated:** 2026-09-21

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                           Frontend                              │
│                    (Next.js + React)                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Catalog UI  │  │ Player UI   │  │ Metadata Editor         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Admin UI    │  │ Auth Pages  │  │ Settings/Enums          │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP/REST (authenticated)
┌────────────────────────────┴────────────────────────────────────┐
│                           Backend                                │
│                    (Next.js API Routes)                          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                      Auth Proxy                            │  │
│  │         (Session validation, redirects)                    │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Catalog API │  │ Transcript  │  │ Metadata API            │  │
│  │ + Streaming │  │ API         │  │ (Curated metadata)      │  │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Auth API    │  │ Admin API   │  │ Audit API               │  │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘  │
│         │                │                     │                │
│         ▼                ▼                     ▼                │
│  ┌─────────────────────────────┐  ┌─────────────────────────┐   │
│  │ File System Access          │  │ PostgreSQL               │   │
│  │ (CSV, JSON, Audio files)    │  │ (Users, Access, Metadata │   │
│  │ [No client paths]           │  │  Audit logs)             │   │
│  └─────────────────────────────┘  └─────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Technology Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| Frontend | Next.js 16 (App Router), React 19 | Full-stack TypeScript |
| UI | shadcn/ui + Tailwind CSS 4 | Accessible components |
| State | TanStack Query 5 | Server state with aggressive revalidation |
| Virtualization | @tanstack/react-virtual | Transcript list virtualization |
| Audio | HTML5 audio element | Custom controls (no waveform) |
| Backend | Next.js API routes | Co-located with UI |
| Database | PostgreSQL 18 | Docker Compose |
| ORM | Prisma 7 | DB client + schema |
| Auth | Better Auth | OAuth + mock OAuth for dev/test |
| i18n | next-intl | en + cs |
| Testing | Vitest + Playwright | Unit + E2E |

## Development Rules

- Server Components are the default for auth, access, and route-boundary decisions.
- Client Components own interactive flows and the client-fetched datasets that back them.
- Use React Query for client-side fetch and mutation flows.
- Keep shareable UI state in the URL; local display preferences in `localStorage` only when established.
- Optional enrichment should fail soft instead of breaking the primary page.
- Prefer explicit fallback chains for runtime choices (audio sources, locale, active-catalog resolution).
- Use the typed capability layer for access control -- no ad hoc policy logic.
- When catalog data includes host paths, rewrite through `BESEDY_PATH_MAPPINGS` before validation and access checks.
- The backend never accepts file paths from clients; it only reads paths stored in the DB or CSVs.

## Page Pattern

1. **Server page** (`web/src/app/**/page.tsx`): auth, access checks, route resolution, and any stable render-time data that is worth loading on the server.
2. **Client child** (colocated client component): interactive state, mutations, and client-owned datasets that need aggressive revalidation or share a React Query cache.
3. **Shared UI** (`web/src/components/`): reusable components.

Current catalog pages use a hybrid model: the server page establishes the access boundary and resolves redirects, while the main recordings/events payloads are still fetched client-side.

## Data Fetching

| Need | Approach |
|------|----------|
| Render-time data | Server Component + direct Prisma access when the data is stable enough to load once at render time |
| Interactive fetch | React Query `useQuery` |
| Write action | React Query `useMutation` |
| Shareable filters/sort/search | URL query params |
| Local display preference | `localStorage` |
| App-wide UI state | React Context |

Query rules: include all dependencies in query keys, invalidate related keys after writes, keep server-side checks authoritative. For catalog/event browsing, the server still owns access checks while the primary interactive datasets remain React Query-managed on the client.

## API Route Pattern

For `web/src/app/api/**/route.ts` handlers:

1. Validate request bodies with Zod.
2. Use shared auth and capability helpers (`requireAuth()`, catalog capability checks).
3. Use shared API error helpers for bad request / not found / conflict / Prisma failures.
4. Add audit logging for sensitive mutations.

Access tiers: Public (`/api/auth/*`, `/api/health`, `/api/csp-report`) -- Authenticated (most reads) -- Admin (catalog management, admissions, admin UI) -- Superadmin (admin-role changes). Admins/superadmins hold every catalog permission in every catalog (`isCatalogAdmin`), per [ADR 0005](../adr/0005-catalog-permission-model.md).

Per-catalog authorization no longer uses an ordered access-level scale. An actor holds a `CatalogRole` (`listener`, `reader`, `corrector`, `host`, `curator`, `catalog_admin`) plus additive `extraPermissions`; every gate below asks whether a specific permission (e.g. `browse_recordings`, `edit_metadata`, `manage_access`) is present rather than whether a level is high enough. See [ADR 0005](../adr/0005-catalog-permission-model.md) for the full permission catalogue and role table, and `web/src/lib/policy/*.ts` for the gates themselves.

### Catalog Endpoints

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/catalog` | `browse_recordings` | List entries with filters |
| GET | `/api/catalog/filter-options` | `browse_recordings` | Dynamic filter values/counts |
| GET | `/api/catalogs/:id/recordings/:hash/entry` | Catalog access, release-scoped | Single enriched entry |
| GET | `/api/catalogs/:id/recordings/:hash/details` | `edit_metadata` | Full source details for edit UI |
| GET | `/api/catalogs/:id/recordings/:hash/audio/sources` | Catalog access, release-scoped | Audio source options |
| GET | `/api/catalogs/:id/recordings/:hash/audio` | Catalog access, release-scoped to stream; `download_audio` to force a download; `original` source additionally requires `download_original_audio` | Stream or download audio |

- "Catalog access, release-scoped" means: the actor holds a grant on the catalog, and if that grant lacks `see_unreleased` the recording must also be published and actionable (`status=ready`); no unpublished or non-actionable rows otherwise. `browse_recordings` is carried by `curator` and `catalog_admin` by default and can otherwise only be granted as a named extra -- `listener`, `reader`, `corrector` and `host` do not have it out of the box.
- `/api/catalog/filter-options`: each filter uses all OTHER applied filters for available values. Date filters are hierarchical (months after year, days after year+month). Requests from a grant without `see_unreleased` are visibility-scoped before counts.

### Event Endpoints

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/catalog-events?group=:id` | Catalog access | List visible events |
| POST | `/api/catalog-events` | `manage_events` | Create event |
| GET | `/api/catalogs/:id/events/:eventId` | Catalog access | Event detail |
| PATCH/DELETE | `/api/catalogs/:id/events/:eventId` | `manage_events` | Update/delete event |
| POST | `/api/catalogs/:id/events/:eventId/recordings` | `manage_events` | Attach recordings |
| DELETE | `/api/catalogs/:id/events/:eventId/recordings/:audioHash` | `manage_events` | Detach recording |
| POST | `/api/catalogs/:id/events/:eventId/recordings/:audioHash/set-primary` | `manage_events` | Set primary recording |
| GET | `/api/catalog-events/unassigned?group=:id` | `manage_events` | Unassigned actionable entries |
| GET | `/api/catalogs/:id/events/health` | `manage_events` | Event health counters |

- Event visibility is enforced server-side via shared access guards (`requireCatalogEventsAccess` in `web/src/lib/catalog-events/access.ts`).
- For a grant without `see_unreleased`, an event is visible only once released, with a published, actionable primary recording; a grant holding `see_unreleased` (`curator`, `catalog_admin`) sees every event regardless of release state.
- ADR 0005 names a separate `release_events` permission, but no route currently gates on it: `canReleaseEvent` in `web/src/lib/policy/event.ts` is presently the same check as `canEditEvent` (`manage_events`), so changing an event's `released` flag requires only `manage_events` today.

### Transcript Endpoints

All four routes first require the recording itself be visible (catalog access, release-scoped, as in the Catalog Endpoints table above), then the permission below.

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/transcript/:hash` | `read_transcripts`; a non-default backend additionally requires `see_transcript_variants`; the `speaker` field on segments additionally requires `see_speakers` | Transcript or available backends |
| GET | `/api/transcript/:hash/speakers` | `read_transcripts` + `see_speakers` | Diarization or available backends |
| GET | `/api/transcript/:hash/formats` | `read_transcripts` | Available download formats |
| GET | `/api/transcript/:hash/download` | `read_transcripts` + `download_transcripts` | Download transcript sidecar |

### Metadata Endpoints

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/catalogs/:id/recordings/:hash/metadata` | Catalog access, release-scoped | Get curated metadata |
| PUT | `/api/catalogs/:id/recordings/:hash/metadata` | `edit_metadata` | Upsert curated metadata |
| DELETE | `/api/catalogs/:id/recordings/:hash/metadata` | `edit_metadata` | Delete curated metadata |
| GET/POST | `/api/metadata/recorders` | Catalog access / `edit_metadata` | List or create recorders |
| GET/PUT/DELETE | `/api/metadata/recorders/:id` | Catalog access / `edit_metadata` | Manage recorder |
| GET/POST | `/api/metadata/locations` | Catalog access / `edit_metadata` | List or create locations |
| GET/PUT/DELETE | `/api/metadata/locations/:id` | Catalog access / `edit_metadata` | Manage location |
| GET/POST | `/api/metadata/albums` | Catalog access / `edit_metadata` | List or create albums |
| GET/PUT/DELETE | `/api/metadata/albums/:id` | Catalog access / `edit_metadata` | Manage album |
| GET | `/api/metadata/artists` | Catalog access | Distinct artist values for filter |
| GET | `/api/metadata/duplicate-counts` | Catalog access | Duplicate count options for filter |

`edit_metadata` is carried only by `curator` and `catalog_admin`, and cannot be granted as an extra. "Catalog access" for a plain read means any active grant on the catalog, or `isCatalogAdmin` -- there is no per-recording release scoping on the lookup/filter endpoints.

### Catalog Management Endpoints

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/catalogs` | Auth | List accessible catalogs |
| POST | `/api/catalogs` | Admin | Create catalog |
| GET/PUT/DELETE | `/api/catalogs/:id` | Admin | Manage catalog |
| GET | `/api/catalogs/discover` | Admin | Discover catalogs on disk |
| GET/POST | `/api/catalogs/:id/variants` | Admin | Manage variants |
| GET/POST | `/api/catalogs/:id/access` | `manage_access` | List/grant access |
| PUT/DELETE | `/api/catalogs/:id/access/:userId` | `manage_access` | Update/revoke access |
| GET/POST | `/api/catalogs/:id/pending-catalog-grants` | `manage_access` | List or create pending grants |
| PUT/DELETE | `/api/catalogs/:id/pending-catalog-grants/:email` | `manage_access` | Manage pending grant |

- POST pending-catalog-grants: if the email belongs to an existing user, access is granted directly.
- `manage_access` is carried by `host` and `catalog_admin` only (not `curator`). Two permissions are protected: `manage_access` and `see_unreleased`. A holder of `manage_access` may grant, update, restore, or revoke only a role that carries neither protected permission -- today `listener`, `reader`, or `corrector` -- and the same protected-permission test applies to the role being replaced; revocation ignores extras on the existing grant, so a `host` can still cut off a `reader` carrying an administrator-assigned extra. Only `catalog_admin` (or a system admin/superadmin) may grant a role carrying a protected permission (`host`, `curator`) or assign extra permissions, and nobody may change their own access. See `canGrantCatalogGrant` / `mayPassOnGrant` in `web/src/lib/policy/catalog.ts` and the "Granting rule" section of [ADR 0005](../adr/0005-catalog-permission-model.md) for the full rule.

### Admin Endpoints

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/admin/users` | Admin | List real portal users |
| GET | `/api/admin/users/stats` | Admin | User stats |
| GET/PATCH | `/api/admin/users/:id` | Admin | User details / status update |
| PUT/DELETE | `/api/admin/users/:id/admin-role` | Superadmin | Toggle admin flag |
| GET/POST | `/api/admin/portal-admissions` | Admin | List or create pending admissions |
| GET/PATCH/DELETE | `/api/admin/portal-admissions/:email` | Admin | Manage pending admission |
| POST | `/api/admin/portal-admissions/reset` | Admin | Reset claimed admission |
| GET | `/api/admin/audit` | Admin | Audit logs (filtered) |
| GET | `/api/admin/audit/:id` | Admin | Single audit log |

- `pending` in user stats counts `portal_admission.status = PENDING`, not `users.status = PENDING`.

### Admin Ingest Endpoints

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/admin/ingest?catalogId=&limit=` | Admin | List recording intakes (live Prefect state overlaid) |
| POST | `/api/admin/ingest/uploads` | Admin | Open a chunked upload (`catalogId`, `filename`, `sizeBytes`) |
| PUT | `/api/admin/ingest/uploads/:intakeId/chunks/:index` | Admin | Store one sequential raw-body chunk as an immutable part |
| POST | `/api/admin/ingest/uploads/:intakeId/finalize` | Admin | Assemble and verify the upload, then submit the ingest job |
| DELETE | `/api/admin/ingest/uploads/:intakeId` | Admin | Abort an unsubmitted upload |
| POST | `/api/admin/ingest/:intakeId/remove` | Admin | Remove an ingested recording and catalog-owned derived data (worker flow), or just the upload files |
| POST | `/api/internal/ingest/:intakeId/complete` | Job service bearer | Worker completion callback; re-syncs the catalog on success |

See [recording-ingest.md](recording-ingest.md) for the end-to-end flow.

### Auth, Preferences, and Utility Endpoints

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| * | `/api/auth/*` | Public | Better Auth (session, signin, callback) |
| GET/PATCH | `/api/preferences` | Auth | Get/update preferences |
| GET/PUT/DELETE | `/api/preferences/audio-source` | Auth | Audio source preferences |
| GET/PUT | `/api/preferences/labs` | Auth | Besedy Labs toggle |
| GET | `/api/me/permissions` | Auth | Current user's permission flags |
| GET | `/api/health` | Public | Health check |
| GET | `/api/version` | Public | Build version and commit info |
| POST | `/api/csp-report` | Public | CSP violation reports |

- Audio source preferences use scoped key `<group>:<hash>`; server keeps only the most recent 100 entries.

### Common Query Params

- `group`: catalog ID override (defaults to active group from preferences/latest accessible).
- `page`, `limit`: pagination. `sort`, `dir`: sorting.

### Error Responses

Endpoints return `{ "error": "Human-readable message" }`. Some include additional fields; there is no single global error envelope.

## Labs Feature Gating

Features can be gated behind the Besedy Labs toggle using a three-layer model: rollout registry, capability evaluation, and API guards.

### Rollout Modes

| Mode | Effect |
|------|--------|
| `off` | Feature disabled for all users |
| `labs` | Available only to users with Labs enabled |
| `public` | Available to all users who pass authorization checks |

### Key Files

| Component | File |
|-----------|------|
| Rollout registry | `src/lib/features/rollout.ts` |
| Capability types | `src/lib/features/types.ts` |
| Capability evaluation | `src/lib/features/capabilities.ts` |
| Per-user Labs preference API | `src/app/api/preferences/labs/route.ts` |
| Per-catalog features API | `src/app/api/catalogs/[id]/features/route.ts` |
| Catalog features hook | `src/hooks/use-catalog-features.ts` |

### Gating Checklist

1. Add feature to `FeatureKey` and `FEATURE_ROLLOUT` in `rollout.ts` (start with `"labs"`).
2. Add capability fields in `types.ts`, compute `canView`/`canEdit` in `capabilities.ts`.
3. Expose capabilities via `GET /api/catalogs/:id/features` (or dedicated endpoint).
4. Gate UI: hide tabs/buttons when `canView` is false, redirect on direct URL access.
5. Add API guard helper and use in every feature endpoint. Never rely on client-side hiding alone.
6. Invalidate related query keys after Labs toggle.
7. Add unit tests for capability logic, route tests for guards, E2E tests for visibility.

### Release / Kill Switch

- **Release:** change rollout mode from `"labs"` to `"public"` -- keep authorization and API guards unchanged.
- **Kill switch:** set rollout mode to `"off"` and deploy.

### Rules

1. Labs is not a replacement for role/catalog authorization.
2. API guards must exist even when UI is hidden.
3. Rollout decision and authorization decision stay separate in code.
4. Feature release should be a rollout config change, not a permission model rewrite.

## Routes & Access

| Page | Route | Access |
|------|-------|--------|
| Home | `/` | Auth (redirects to active catalog or admin) |
| Catalog | `/catalog/[catalogId]` | Catalog access (any active grant, or `isCatalogAdmin`); `?tab=recordings` additionally requires `browse_recordings` |
| Event Detail | `/catalog/[catalogId]/event/[eventId]` | Catalog access |
| Event Edit | `/catalog/[catalogId]/event/[eventId]/edit` | `manage_events` |
| Recording | `/catalog/[catalogId]/recording/[hash]` | Catalog access, release-scoped (transcripts: `read_transcripts`) |
| Recording Edit | `/catalog/[catalogId]/recording/[hash]/edit` | `edit_metadata` |
| Catalog Settings | `/catalog/[catalogId]/settings` | Separately gated cards, page opens if any applies: access card needs `manage_access`; configuration card needs `manage_catalog_config` (`catalog_admin` wildcard only); event health card needs `manage_events`; transcript-exports card needs `bulk_export_transcripts` |
| User Settings | `/settings` | Auth |
| Admin | `/admin` | Admin |
| Admin Ingest | `/admin/ingest` | Admin |
| Sign In | `/auth/signin` | Public |

- Auth proxy (`src/proxy.ts`) redirects unauthenticated users to `/auth/signin`.
- Catalog access is enforced by API routes; pages may render but show errors if access is denied.
- `/catalog/[catalogId]` is events-first by default: viewing events only needs catalog access, while the recordings list needs the `browse_recordings` permission, which `curator` and `catalog_admin` carry by default and any role can otherwise be granted as a named extra.

## Responsive Design

The app uses a **hybrid** responsive system. Primary mobile/desktop divider is
`768px` (`md:` / `@[768px]`).

- **Viewport media queries + state gating** — for interactive components with
  popups/drawers (`ResponsiveSelect`, `ResponsiveMenu`, `NotificationBell`).
  Both the desktop and mobile DOM trees are always rendered; the inactive
  trigger is hidden with CSS (`md:contents` / `md:hidden`). **Critically, the
  portal `open` state is gated** (`const desktopOpen = isDesktop ? open : false`):
  portals escape a parent's `display:none`, so without gating both a
  DropdownMenu and a Drawer could open at once (z-index/overlap and two-open-
  dialog a11y bugs). `useIsDesktop()` (`hooks/use-media-query`) drives this via
  `useSyncExternalStore` and returns `false` during SSR for safe hydration — it
  gates state, not conditional rendering.
- **CSS container queries** (`@container/catalog` + `@[768px]/catalog:...`) —
  for content areas like `CatalogList` that occupy real width and involve no
  portals; sizing adapts to available space rather than viewport.
- Use `md:contents` (not `md:block`) for the desktop wrapper so it doesn't add a
  layout box inside flex/grid; the child component controls its own display.

**`landscape-mobile` variant:** phones in landscape are ≥768px wide but should
still show mobile UI. Defined in `globals.css` as
`@media (min-width: 768px) and (max-height: 499px)`; pair it with the viewport
classes (`hidden md:block landscape-mobile:hidden` for desktop-only,
`md:hidden landscape-mobile:block` for mobile-only). Notched devices use the
`safe-top` / `safe-bottom` utilities (`env(safe-area-inset-*)`).

## PWA Install & Update Banners

Behavior with non-obvious rules (UI in `components/pwa/install-banner.tsx`,
`components/update-banner.tsx`; state in `contexts/service-worker-context.tsx`):

- **Install banner** shows only when: user is logged in, route is not under
  `/auth`, a native `beforeinstallprompt` was captured, not already installed,
  and not previously dismissed. Dismissal is permanent in `localStorage`
  (`pwa-install-dismissed`). On platforms with no native prompt (Safari/iOS) the
  banner stays hidden; the user-menu install item provides manual instructions.
- **Update banner** shows only to **logged-in** users when an update is
  available and not dismissed. **Logged-out sessions never see it and
  auto-apply updates** (SKIP_WAITING) to avoid stale sign-in pages.
- **Updates auto-apply after a deadline** (default 24h from detection) once the
  tab is hidden or the user is idle (default 5min, checked every 30s). An update
  arriving mid-playback waits until audio stops (1s delay). Unsaved edits and
  in-flight mutations block both manual and automatic reloads, with blockers
  shared across tabs through `BroadcastChannel`. Every activation first proves
  `/api/version` is reachable instead of trusting `navigator.onLine`, and a
  failed probe retries every 30 seconds. A manually requested retry falls back
  to automatic blocker policy until the user explicitly requests it again; the
  waiting banner can also cancel the retry. If browser
  activation takes longer than 8 seconds, the banner becomes dismissible while
  activation continues in the background and records an `ACTIVATION_DELAYED`
  telemetry event. The version-scoped state is
  stored under `besedy-sw-update-state`; a **newer web version clears an older
  dismissal** so the banner reappears.
- **Update detection:** the provider polls `/api/version` with
  `cache: "no-store"` and compares the returned `webVersion` against the
  version embedded in the running client. `WEB_VERSION` is derived from
  allowlisted production inputs and public build configuration, so unrelated
  repository commits, tests, and documentation do not prompt a web update.
  `/sw.js` is registered with `updateViaCache: "none"`, stamped with the same
  web version, and reports that identity before activation so a stale waiting
  worker cannot be mistaken for the current target.

## Offline

Offline mode is documented in [offline.md](offline.md). In short: users
download events or recordings from the page-side download manager
(`lib/offline/download-manager.ts`), the registry lives in IndexedDB, and the
service worker (`public/sw.js`) serves downloaded audio and the dedicated
session-free `/downloads` shell when the network is unavailable. Normal
application pages and API responses are not cached for offline use; failed
offline navigations are redirected to the device-local Downloads library.

Catalog staleness markers are unrelated to downloads: `useCatalogStatus`
stores `lastModifiedAt` in `localStorage` to detect server-side changes while
online.
