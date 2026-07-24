# Web Application Architecture

> **Last Updated:** 2026-04-20

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

Access tiers: Public (`/api/auth/*`, `/api/health`, `/api/csp-report`) -- Authenticated (most reads) -- Admin (catalog management, admissions, admin UI) -- Superadmin (admin-role changes). Admins/superadmins effectively have owner-level access across catalogs.

### Catalog Endpoints

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/catalog` | LISTENER+ | List entries with filters |
| GET | `/api/catalog/filter-options` | LISTENER+ | Dynamic filter values/counts |
| GET | `/api/catalogs/:id/recordings/:hash/entry` | LISTENER+ | Single enriched entry |
| GET | `/api/catalogs/:id/recordings/:hash/details` | EDITOR+ | Full source details for edit UI |
| GET | `/api/catalogs/:id/recordings/:hash/audio/sources` | LISTENER+ | Audio source options |
| GET | `/api/catalogs/:id/recordings/:hash/audio` | LISTENER+ stream, MEMBER+ download | Stream or download audio |

- LISTENER catalog data is scoped to published, actionable recordings only (`status=ready`; no unpublished or non-actionable rows).
- `/api/catalog/filter-options`: each filter uses all OTHER applied filters for available values. Date filters are hierarchical (months after year, days after year+month). LISTENER requests are visibility-scoped before counts.

### Event Endpoints

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/catalog-events?group=:id` | LISTENER+ | List visible events |
| POST | `/api/catalog-events` | OWNER/Admin | Create event |
| GET | `/api/catalogs/:id/events/:eventId` | LISTENER+ | Event detail |
| PATCH/DELETE | `/api/catalogs/:id/events/:eventId` | OWNER/Admin | Update/delete event |
| POST | `/api/catalogs/:id/events/:eventId/recordings` | OWNER/Admin | Attach recordings |
| DELETE | `/api/catalogs/:id/events/:eventId/recordings/:audioHash` | OWNER/Admin | Detach recording |
| POST | `/api/catalogs/:id/events/:eventId/recordings/:audioHash/set-primary` | OWNER/Admin | Set primary recording |
| GET | `/api/catalog-events/unassigned?group=:id` | OWNER/Admin | Unassigned actionable entries |
| GET | `/api/catalogs/:id/events/health` | OWNER/Admin | Event health counters |

- Event visibility is enforced server-side via shared access guards.
- Listener-visible events are scoped by event release state and primary-recording listener visibility.

### Transcript Endpoints

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/transcript/:hash` | VIEWER+ | Transcript or available backends |
| GET | `/api/transcript/:hash/speakers` | VIEWER+ | Diarization or available backends |
| GET | `/api/transcript/:hash/formats` | VIEWER+ | Available download formats |
| GET | `/api/transcript/:hash/download` | MEMBER+ | Download transcript sidecar |

### Metadata Endpoints

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/catalogs/:id/recordings/:hash/metadata` | LISTENER+ | Get curated metadata |
| PUT | `/api/catalogs/:id/recordings/:hash/metadata` | EDITOR+ | Upsert curated metadata |
| DELETE | `/api/catalogs/:id/recordings/:hash/metadata` | EDITOR+ | Delete curated metadata |
| GET/POST | `/api/metadata/recorders` | Auth / EDITOR+ | List or create recorders |
| GET/PUT/DELETE | `/api/metadata/recorders/:id` | Auth / EDITOR+ | Manage recorder |
| GET/POST | `/api/metadata/locations` | Auth / EDITOR+ | List or create locations |
| GET/PUT/DELETE | `/api/metadata/locations/:id` | Auth / EDITOR+ | Manage location |
| GET | `/api/metadata/artists` | Auth | Distinct artist values for filter |
| GET | `/api/metadata/albums` | Auth | Distinct album values for filter |
| GET | `/api/metadata/duplicate-counts` | Auth | Duplicate count options for filter |

### Catalog Management Endpoints

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/catalogs` | Auth | List accessible catalogs |
| POST | `/api/catalogs` | Admin | Create catalog |
| GET/PUT/DELETE | `/api/catalogs/:id` | Admin | Manage catalog |
| GET | `/api/catalogs/discover` | Admin | Discover catalogs on disk |
| GET/POST | `/api/catalogs/:id/variants` | Admin | Manage variants |
| GET/POST | `/api/catalogs/:id/access` | OWNER/Admin | List/grant access |
| PUT/DELETE | `/api/catalogs/:id/access/:userId` | OWNER/Admin | Update/revoke access |
| GET/POST | `/api/catalogs/:id/pending-catalog-grants` | OWNER/Admin | List or create pending grants |
| PUT/DELETE | `/api/catalogs/:id/pending-catalog-grants/:email` | OWNER/Admin | Manage pending grant |

- POST pending-catalog-grants: if the email belongs to an existing user, access is granted directly.
- OWNERs can grant LISTENER/VIEWER/MEMBER/EDITOR; only Admins can create OWNER-level pending grants.

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
| Catalog | `/catalog/[catalogId]` | LISTENER+ |
| Event Detail | `/catalog/[catalogId]/event/[eventId]` | LISTENER+ |
| Event Edit | `/catalog/[catalogId]/event/[eventId]/edit` | OWNER/Admin |
| Recording | `/catalog/[catalogId]/recording/[hash]` | LISTENER+ (transcripts: VIEWER+) |
| Recording Edit | `/catalog/[catalogId]/recording/[hash]/edit` | EDITOR+ |
| Catalog Settings | `/catalog/[catalogId]/settings` | OWNER/Admin |
| User Settings | `/settings` | Auth |
| Admin | `/admin` | Admin |
| Sign In | `/auth/signin` | Public |

- Auth proxy (`src/proxy.ts`) redirects unauthenticated users to `/auth/signin`.
- Catalog access is enforced by API routes; pages may render but show errors if access is denied.
- `/catalog/[catalogId]` is events-first for listeners; recordings list available for event-management roles.

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
- **Dismissed updates auto-apply after a deadline** (default 24h) once the tab
  is hidden or the user is idle (default 5min, checked every 30s) **and audio is
  not playing** — an update arriving mid-playback waits until audio stops (1s
  delay). Keys: `besedy-sw-update-dismissed`,
  `besedy-sw-update-dismissed-deadline`. A **newer build clears the dismissal**
  so the banner reappears.
- **Update detection:** the provider polls `/api/version` with
  `cache: "no-store"` and compares the returned `commit` (sourced from the
  `GIT_COMMIT` build env) against the running build; a changed commit signals a
  new version. `/sw.js` is registered with `updateViaCache: "none"` but is not
  itself the update signal.

## Offline

### What Works

- **Manual audio caching:** `useContentCache` downloads audio in chunks via the Service Worker (`public/sw.js`).
- **Offline banner:** fixed banner shown when offline (`components/offline-banner.tsx`).
- **Catalog staleness markers:** `useCatalogStatus` stores `lastModifiedAt` in `localStorage` to detect server-side changes.

### What Does Not Work Offline

- Transcript and diarization requests (return `503`).
- Reloading catalog into a browsable offline view.
- Audio for recordings not previously cached.
- Metadata edits and other write actions.
- Fresh server-side search/filter data.

Navigation requests use network-first `cache: "no-store"`. React Query data is treated as stale immediately and refetched on mount/focus.

### Troubleshooting

- **Service Worker issues:** DevTools -> Application -> Service Workers -> Unregister, then refresh. If the app was opened via plain `http://<LAN-IP>:3001`, the browser will not register the SW at all -- use `localhost` or an HTTPS origin for offline caching.
- **Clear cached data:** DevTools -> Application -> Storage -> Clear site data, or browser privacy settings.
- **Storage quota:** Large audio files consume significant storage. Clear old cached recordings and check browser storage settings.
