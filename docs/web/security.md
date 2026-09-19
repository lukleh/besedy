# Web Security Reference

> **Last Updated:** 2026-09-17

Dense reference for agents working on auth, access control, and deployment
hardening.

- Test accounts: see AGENTS.md (seeded web auth users) and `web/prisma/test-data.ts`
- Audit action types: `AuditAction` enum in `prisma/schema.prisma`
- Path validation: `web/src/lib/security/path-validation.ts`
- Monitoring scripts and schedules: `docs/web/operations.md`
- Retired LAN egress control: `docs/web/egress-control-retirement.md`

---

## Authentication

Besedy uses **allowlist-only authentication** with Better Auth. Users cannot
self-register.

**Why allowlist-only?** Self-registration would expose the app to:

- **Enumeration attacks** -- probing which emails exist
- **Spam accounts** -- cluttering user management
- **Unauthorized discovery** -- accessing catalog content without invitation

### Portal Admission Flow (OAuth)

1. Admin creates a portal admission (`POST /api/admin/portal-admissions`) or a
   catalog-scoped pending grant (`POST /api/catalogs/:id/pending-catalog-grants`).
2. User signs in with OAuth (Google).
3. Auth creation hooks validate portal-admission state and any pending catalog
   grants.
4. If the email is **not** admitted, sign-in is rejected and routed to
   unauthorized UX.
5. If the email **is** admitted, session creation continues and normal access
   checks apply.

### Superadmin Bootstrap

Configure `superadmin_email` in `besedy.toml` `[web]` section. That email can
sign in via OAuth without a pending admission and is automatically granted
superadmin status.

---

## Session Management

### Session Strategy

OAuth flows use **database sessions** via the Prisma adapter. Sessions are
stored server-side; the client holds only a signed cookie referencing the
session row.

### Redesign Contract (Target State)

1. Only **ACTIVE + valid session** = authenticated.
2. **PENDING** and **BLOCKED** users are treated as signed-out.
3. API semantics are strict: `401` = unauthenticated, `403` = unauthorized.
4. `/api/catalogs` is strictly authenticated.

### Signed Cookie Verification

Next.js 16 renamed the `middleware` file convention to `proxy`. In this repo,
the auth gate lives in `web/src/proxy.ts`; do not add a new `middleware.ts` or
reintroduce `middleware*` config keys in `web/next.config.ts`.

The auth proxy performs HMAC-SHA256 verification of session cookies
(format: `value.signature`) using `AUTH_SECRET` before trusting them. Invalid
or missing signatures are rejected.

### Session Redirect Loop Incident (2026-02-08)

Production users hit `ERR_TOO_MANY_REDIRECTS` with a repeating
`/auth/signin` <-> `/catalog` cycle.

**Root cause:** Redirect decisions were split between the auth proxy (`src/proxy.ts`)
and server rendering in `src/app/auth/signin/page.tsx`. The sign-in page
performed a server-side redirect to `/catalog` when `getSession()` returned a
user, while the proxy could still treat the same request as unauthenticated and
redirect back to `/auth/signin`. Legacy plain auth cookies from older behavior
conflicted with production secure-cookie expectations.

**Fix:** Keep the auth proxy as the single authority for auth redirects. Remove
server-side redirect from the sign-in page. Treat `__Secure-besedy.session_token`
as authoritative in production. Clear stale auth cookies when legacy/secure
cookies disagree and send the user through a clean sign-in path.

> **WARNING -- Guardrails (do not regress):**
>
> - Do **not** add server-side `redirect()` logic back to `/auth/signin` based
>   on session state.
> - Keep all auth routing decisions in the auth proxy. Do not reintroduce
>   client-side auth truth probing.
> - When changing session cookie semantics, include compatibility cleanup that
>   removes stale cookies.

---

## Route Protection

The auth proxy (`src/proxy.ts`) enforces authentication for all routes
except:

- `/auth/*`, `/api/auth/*`
- `/api/version`, `/api/csp-report`
- Static assets

Unauthenticated requests are redirected to `/auth/signin`.

### Rate Limiting

| Setting  | Value                                          |
| -------- | ---------------------------------------------- |
| Limit    | 30 requests per IP                             |
| Window   | 60 seconds                                     |
| Scope    | `/api/auth/*` routes                           |
| Response | `429 Too Many Requests` with `Retry-After: 60` |

Rate limiting is bypassed in dev/test environments.

### Security Headers

| Header                      | Value                                      | Purpose                             |
| --------------------------- | ------------------------------------------ | ----------------------------------- |
| `X-Frame-Options`           | `DENY`                                     | Prevent clickjacking                |
| `X-Content-Type-Options`    | `nosniff`                                  | Prevent MIME sniffing               |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`          | Control referrer info               |
| `X-XSS-Protection`          | `1; mode=block`                            | XSS filter (legacy browsers)        |
| `Permissions-Policy`        | `camera=(), microphone=(), geolocation=()` | Disable sensitive APIs              |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`      | HTTPS enforcement (production only) |

HSTS is enabled only when `APP_ENV=production` (fallback: `NODE_ENV=production`).

CSP is **enforced** (not report-only). script-src uses a per-request nonce:
`script-src 'self' 'nonce-<value>' 'strict-dynamic'` with no `'unsafe-inline'`
(`'unsafe-eval'` is allowed only in development). The nonce is generated per
request in `src/proxy.ts` and applied to Next.js framework scripts via the
`x-nonce` request header. Violations are reported to `/api/csp-report`.

### Path Validation

All file access (audio, transcripts) goes through symlink-aware path validation
to prevent directory traversal. Paths are resolved via `fs.realpathSync()` and
must fall within `BESEDY_BASE_DIR` or any additional directories listed in
`BESEDY_ALLOWED_PATHS`. Non-existent paths are rejected before access.

### Audit Logging

Audit events are stored in `audit_log`. Admins can query logs in `/admin/audit`;
non-superadmins see only their own logs. All auth, access, data, and content
events are tracked. See `AuditAction` enum in `prisma/schema.prisma` for the
complete list.

---

## Access Control

Authorization is centralized in `src/lib/policy/*`, `src/lib/access/*`, and
`src/lib/features/*`.

### System roles and catalog roles

System roles (`SUPERADMIN`, `ADMIN`, `USER`) govern portal administration.
Catalog roles are independent, named permission sets on one catalog:

| Catalog role    | Baseline purpose                                              |
| --------------- | ------------------------------------------------------------- |
| `listener`      | Listen to released recordings                                 |
| `reader`        | Listen, read, and search transcripts                          |
| `corrector`     | Reader plus transcript correction                             |
| `host`          | Reader plus access management                                 |
| `curator`       | Editorial and publication work, including unreleased material |
| `catalog_admin` | Every current and future catalog permission                   |

System admins resolve as catalog administrators for every catalog. A stored
`catalog_admin` role grants the same authority only on its own catalog.

Grants and grant APIs are role-native. The non-null `access_level` column is
retained only as a compatibility projection while old data and tooling are
retired; authorization never derives from it when a role is present. Existing
levels were migrated as follows:

| Legacy level       | Stored role | Migration extra        |
| ------------------ | ----------- | ---------------------- |
| `LISTENER`         | `listener`  | none                   |
| `VIEWER`, `MEMBER` | `reader`    | none                   |
| `EDITOR`           | `curator`   | none                   |
| `OWNER`            | `host`      | `download_transcripts` |

An account may carry curated extra permissions beside its role. Extras are
additive only, so the role remains a lower bound. Unknown names are ignored.

### System-Level Access Matrix

| Feature                       | Superadmin | Admin |           User            |
| ----------------------------- | :--------: | :---: | :-----------------------: |
| Admin panel                   |     Y      |   Y   |             -             |
| Manage users and catalogs     |     Y      |   Y   |             -             |
| Grant or revoke system admin  |     Y      |   -   |             -             |
| Catalog settings              |     Y      |   Y   |     per catalog role      |
| Manage pending catalog access |     Y      |   Y   | `host` or `catalog_admin` |

### Catalog-Level Access Matrix

The baseline matrix below excludes additive extras. `catalog_admin` is a
wildcard; system admins resolve the same way.

| Capability group                                | listener | reader | corrector | host | curator | catalog_admin |
| ----------------------------------------------- | :------: | :----: | :-------: | :--: | :-----: | :-----------: |
| Open catalog and stream audio                   |    Y     |   Y    |     Y     |  Y   |    Y    |       Y       |
| Read and search transcripts                     |    -     |   Y    |     Y     |  Y   |    Y    |       Y       |
| Correct transcripts                             |    -     |   -    |     Y     |  -   |    Y    |       Y       |
| See unreleased material                         |    -     |   -    |     -     |  -   |    Y    |       Y       |
| Browse recordings list                          |    -     |   -    |     -     |  -   |    Y    |       Y       |
| Edit metadata, lookups, events, and publication |    -     |   -    |     -     |  -   |    Y    |       Y       |
| Use deep search                                 |    -     |   -    |     -     |  -   |    Y    |       Y       |
| Manage catalog access                           |    -     |   -    |     -     |  Y   |    -    |       Y       |
| Manage catalog configuration                    |    -     |   -    |     -     |  -   |    -    |       Y       |
| See transcript variants and speaker overlay     |    -     |   -    |     -     |  -   |    -    |       Y       |
| Download playable audio and transcripts         |    -     |   -    |     -     |  -   |    Y    |       Y       |
| Download original audio                         |    -     |   -    |     -     |  -   |    -    |       Y       |
| Bulk transcript export                          |    -     |   -    |     -     |  -   |    Y    |       Y       |

Catalog administrators may assign the curated extras `browse_recordings`,
`use_deep_search`, `download_audio`, `download_original_audio`,
`download_transcripts`, and `bulk_export_transcripts` to a named account.
Delivery permissions never bypass the corresponding read/visibility gate.

The recordings list is a separate surface from opening one recording through
an event, search result, or radio. Offline caching likewise follows
`stream_audio`; it has no separate permission and cannot widen what the source
routes deliver.

**System-wide (not catalog-scoped)**

| Capability                                                                                           | Required role          |
| ---------------------------------------------------------------------------------------------------- | ---------------------- |
| Admin panel, user management, audit log, MCP usage telemetry, transcript backend order, catalog sync | ADMIN                  |
| Grant / revoke admin role                                                                            | SUPERADMIN             |
| Labs toggle, notification preferences, playback progress                                             | any authenticated user |

### Listener role

`listener` is the default role for new pending catalog grants. Listeners can
access the catalog homepage, stream audio, and cache downloaded events for
offline playback, but cannot view transcripts. The catalog is events-first for
listeners; recording detail access follows listener visibility rules.

### Surface Differences

The web UI is not the only read surface, and the surfaces do not agree:

| Surface            | Unreleased events         | Transcript read                              | Release scoping                   |
| ------------------ | ------------------------- | -------------------------------------------- | --------------------------------- |
| Web UI / web API   | `curator` / catalog admin | `reader` and above by permission             | requester's role and extras       |
| MCP                | nobody, including admins  | **every active grant, including `listener`** | uniform listener-visible material |
| Deep-search worker | requester's visibility    | requester must be able to read               | requester's role and extras       |

The MCP listener-transcript decision is deliberate and dated; see
[mcp-server.md](mcp-server.md#design-decision-listener-transcript-access-through-mcp).
"MCP usage" in the system-wide table means the administrative usage-telemetry
page, not permission to connect an MCP client. MCP client access follows portal
status, while catalog-scoped calls follow live catalog grants as described in
that decision. Any change to who may read transcripts has to be considered on
both surfaces; changing the web gate alone intentionally does not alter MCP.

### Access Management Rules

Two permissions are **protected**: `manage_access` and `see_unreleased`. Only a
catalog administrator may assign or modify a grant carrying either. The test is
on the grant's permissions rather than its role name, so a role added later is
classified without updating a name list.

A `host` can create, update, revoke, and restore `listener`, `reader`, and
`corrector` grants, including pending grants. A host cannot manage `host`,
`curator`, or `catalog_admin`, and cannot assign extras. A catalog administrator
can manage every role and the curated extras. Revocation is the narrow
exception: a host may revoke an ordinary role carrying administrator-assigned
extras, but cannot edit or restore it.

Nobody can change their own catalog grant, including administrators. Updates
and restores apply the same assignability test to both the old and new grant;
revocation separately protects the old role while allowing extras to be cut
off with it.

**Why the two permissions are protected:** `manage_access` prevents privilege
escalation chains — an account that grants could otherwise mint another account
that grants, propagating without admin oversight. `see_unreleased` keeps sight
of unreleased material an administrative decision rather than something an
account can pass on.

**Why nobody changes their own access:** a role is conferred rather than taken.
Administrators are included, which also preserves the older guard against an
account revoking itself out of a catalog.

### Delivery and Background Jobs Are Scoped Like Reading

Two paths used to hand over more than the account asking could read.

**Bulk transcript export** exported every recording in the catalog. It now
exports what the requester could have opened one recording at a time, using the
same per-recording visibility as the single-transcript route. An administrator
is unscoped and still gets everything.

**Deep search** ran with no identity at all: the worker authenticated with the
service secret and the internal search treated that as full visibility, so a
report could quote unreleased material to someone who cannot read it. The job
now carries the account it was asked for, and the internal search, citation and
metadata routes scope to that account. A missing requester or a requester whose
access was revoked is rejected; neither falls back to listener visibility.

The service secret still says only that the caller is our own worker. It is
shared by the web-to-jobs client, the jobs API and the worker-to-web client, so
one leaked value is worth treating as a full compromise of job submission and
retrieval.

### File Delivery Is One Permission Per Thing Delivered

There is no general "may download". Which file is leaving decides which
permission, so an account given transcripts does not thereby get audio, and
neither of them gets the whole corpus in one request.

| Permission                     | Covers                                        | Who                                            |
| ------------------------------ | --------------------------------------------- | ---------------------------------------------- |
| `download_audio`               | The playable file                             | `curator`, `catalog_admin`, or a named account |
| `download_original_audio`      | The master                                    | `catalog_admin` only — no role carries it      |
| `download_transcripts`         | One transcript the account can already read   | `curator`, `catalog_admin`, or a named account |
| `download_original_transcript` | The machine text under a corrected transcript | `curator`, `catalog_admin`                     |
| `bulk_export_transcripts`      | The whole catalog as data                     | `curator`, `catalog_admin`                     |

Each is never broader than reading: they decide whether an account may take out
what it can already open, not what it may open. The transcript ones therefore
also require `read_transcripts`.

`download_original_transcript` is gated but serves nothing yet. There are no
corrections, so there is no machine text underneath a corrected transcript; the
permission exists so the correction work has one to hang the variant on rather
than inventing it then.

**This is a stance about what the product is, not a control boundary.** Besedy
is used by listening and reading inside it; taking files out serves specific,
occasional purposes. Two things follow, both deliberate and recorded in
[ADR 0005](../adr/0005-catalog-permission-model.md):

- The audio route returns the whole file to anyone who may play it, so
  `download_audio` decides whether the interface offers a download, not whether
  the bytes are reachable. `download_original_audio` is different: it gates the
  path, on every request rather than only on a forced download, because serving
  the master inline would deliver the same bytes.
- Offline caching needs no permission of its own. It writes audio to the
  viewer's device, but it delivers the same listening `stream_audio` already
  describes. A transcript is different: the Downloads bundle persists readable
  text, so it is included only for an account with `download_transcripts`.

### Browsing Recordings Is a Surface, Not Catalog Access

`browse_recordings` covers the recordings list. `/api/catalog` and
`/api/catalog/filter-options` refuse without it, the tab switcher appears only
when both surfaces are available, and a `?tab=recordings` deep link asks the
same permission rather than asking about the switcher.

**Only the list.** A single recording stays reachable: the events surface
renders the recording page inside itself for an event's recordings, search
results link straight to a recording at a timestamp, and radio plays one. Those
answer to `canAccessRecording`, `stream_audio` and `read_transcripts` as before.
What the permission decides is whether the whole catalog is browsable as a list
of recordings, which is the editorial view of the archive rather than the way it
is listened to.

Of the roles, only `curator` and `catalog_admin` carry it, so the catalog is
events-only for everyone else. That is a real change for one account, named and
accepted in [ADR 0005](../adr/0005-catalog-permission-model.md).

### Machine-Output Views Are Administrative

Two permissions sit with the catalog administrator alone, and with no other
role.

`see_transcript_variants` covers the fact that more than one machine transcript
exists. Without it, `GET /api/transcript/:hash` lists only the default backend
and refuses to serve any other, `GET /api/transcript/:hash/compare` — the
multi-backend stream view in its entirety — is refused, and the picker, the
variant counts and the stream switch are not rendered. **Reading is now the
default view**; the stream used to be, and a stored preference saying so does
not reopen it.

`see_speakers` covers the diarization overlay. Without it,
`GET /api/transcript/:hash/speakers` reports no backends, the `speaker` on each
transcript segment is dropped from the response, and the toggle, the overlay and
the detected-speaker count are not rendered.

Both are about unevaluated model output rather than about release state, so
neither reaches unreleased material and neither is a substitute for
`see_unreleased`. Both are candidates to open later — diarization once speaker
attribution becomes a phase of correction.

### CatalogAccess Retention for Blocked Users

When a user is blocked, their `CatalogAccess` records are **retained**. Access
is denied at runtime via user status checks. This allows easy restoration of
previous access when unblocking.

### Capability Helpers

Prefer the typed capability layer over older ad hoc permission helpers:

| Helper                         | Scope                                 |
| ------------------------------ | ------------------------------------- |
| `getPortalCapability()`        | Portal admission and top-level access |
| `getAdminCapability()`         | Admin surfaces                        |
| `getCatalogCapability()`       | Catalog-scoped access                 |
| `getRecordingCapability()`     | Recording-scoped access               |
| `requireCatalogEventsAccess()` | Event visibility and edit checks      |

Compatibility helpers still exist in `src/lib/auth/permissions.ts`; new policy
logic should be added to the capability layer first.

### DTO Boundary Rules

Access control also governs what leaves a route, not just who may call it:

- Viewer- and member-facing routes must return **sanitized DTOs**, never raw
  Prisma rows or CSV-derived source records. `CatalogEntryResponse` is the
  baseline viewer-facing recording DTO.
- Viewer/member DTOs **must not expose path-bearing or source-only fields**
  (filesystem paths, source records). Those fields may appear **only** in
  explicitly edit-oriented DTOs and routes, behind an edit-capability check.
- **Aggregates must match visibility.** User-visible counts, filter options, and
  similar metadata must be derived from the same visibility-scoped dataset as
  the visible rows — listener-inaccessible rows must never contribute to
  user-visible counts or filter options.
- **Admin/access surfaces default to active grants only.** Revoked grants may
  appear only in explicit history or restore workflows.
- New routes should depend on typed capability objects rather than recomputing
  access from several helper layers. Where `403`-vs-`404` ordering matters, keep
  that ordering explicit in the route while still using the canonical capability
  source.

### Workflow Invariants vs Authorization

Some checks are **domain/workflow invariants** ("is the resource state valid for
this action?"), not authorization ("may this actor do it?"). Keep them separate
from the policy layer — they hold regardless of who acts:

- An event may be **released only when it has exactly one primary recording**.
- A released event **cannot lose its only primary recording**.
- An **incomplete recording cannot be published**.
- A recording in a **released event cannot be unpublished**.

Listener visibility depends on both: a listener may view a recording only when
it is actionable and published, and may view an event only when the event is
released and its primary recording is actionable and published.

---

## Deployment Security

### Deployment Context

| Aspect      | Value                                                             |
| ----------- | ----------------------------------------------------------------- |
| Environment | Single host running Docker Compose                                |
| Network     | Cloudflare Tunnel (outbound-only, no inbound ports)               |
| TLS         | Cloudflare terminates TLS, provides DDoS protection               |
| Goal        | Reasonable security, minimal blast radius on container compromise |

When this guide references `.env.prod`, read that as the resolved production
env file (`BESEDY_WEB_ENV_PROD` or `~/.config/lukleh/besedy/web.env.prod`).

### Container Hardening Checklist

| Control                                                  | Status | Source                                                                    |
| -------------------------------------------------------- | :----: | ------------------------------------------------------------------------- |
| Non-root user (UID 1001)                                 |  Done  | `Dockerfile`                                                              |
| Read-only data mount (`:ro`)                             |  Done  | `docker-compose.secure.yml`                                               |
| Localhost-only port (`127.0.0.1:3000`)                   |  Done  | `docker-compose.secure.yml`                                               |
| DB user split (`besedy_migrator` DDL / `besedy_app` DML) |  Done  | Host-only migrator, container app user                                    |
| Read-only container filesystem + tmpfs                   |  Done  | `docker-compose.secure.yml`                                               |
| `cap_drop: ALL`                                          |  Done  | `docker-compose.secure.yml`                                               |
| `no-new-privileges: true`                                |  Done  | `docker-compose.secure.yml`                                               |
| Resource limits (2 CPU, 1 GB RAM)                        |  Done  | `docker-compose.secure.yml`                                               |
| Syslog logging                                           |  Done  | Docker logs to host syslog                                                |
| LAN egress isolation                                     |  Open  | Retired; see [egress-control-retirement.md](egress-control-retirement.md) |
| Cloudflare Tunnel (outbound-only)                        |  Done  | No listening port to attack                                               |

### Container Escape Vectors

| Vector                    | Risk     | Mitigation                                                                                |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| Kernel exploit            | Low      | Alpine is minimal but not hardened                                                        |
| Docker socket             | None     | Not mounted                                                                               |
| Host filesystem           | None     | Only `/data` (read-only), container FS read-only                                          |
| Privilege escalation      | Very Low | UID 1001, all caps dropped, no-new-privileges                                             |
| Network pivot to LAN      | Medium   | No repository-managed egress block; see [retirement record](egress-control-retirement.md) |
| Network pivot to Internet | Medium   | Internet allowed for OAuth                                                                |

### Blast Radius: Web Container Compromised

**What an attacker CAN do:**

| Access                  | Detail                                          |
| ----------------------- | ----------------------------------------------- |
| Read audio/transcripts  | `/data` mounted read-only                       |
| Full DB read/write      | Via `DATABASE_URL` env var                      |
| Network to DB container | Docker network                                  |
| Reach LAN services      | No repository-managed container egress firewall |
| Exfiltrate data         | Outbound internet (required for OAuth)          |
| Delete audit logs       | Via database access                             |

**What an attacker CANNOT do:**

| Blocked                              | Why                                 |
| ------------------------------------ | ----------------------------------- |
| Write to audio files                 | Read-only mount                     |
| Access host filesystem               | No host mounts beyond `/data`       |
| Access other containers' filesystems | No shared volumes, no Docker socket |
| Escape to host                       | No privileged mode, no capabilities |
| Access cloudflared credentials       | Stored on host, not in container    |

### Lateral Movement Summary

| Path               | Method                                                    | Risk           |
| ------------------ | --------------------------------------------------------- | -------------- |
| web -> db          | `DATABASE_URL` env var                                    | High (full DB) |
| web -> backup      | None (no shared creds)                                    | Low            |
| web -> host        | `host.docker.internal`; exposure depends on host services | Medium         |
| web -> cloudflared | Runs on host                                              | Low            |
| web -> LAN         | Container network; not filtered by Besedy                 | Medium         |
| web -> Internet    | Outbound TCP/HTTP                                         | Medium (OAuth) |

### Cloudflare Origin Protection

The Cloudflare Tunnel architecture eliminates the three main origin-bypass
attacks (shared certificate bypass, IP range allowlist abuse, direct origin
access). The tunnel is outbound-only -- there is no listening port, no inbound
firewall rules, and the origin IP is behind NAT. This is stronger than
traditional Cloudflare proxy setups where you expose a port and allowlist
Cloudflare IPs.

Optional defense-in-depth: verify `cf-ray` header in middleware to reject
requests not arriving via Cloudflare. Note: an attacker with their own
Cloudflare account could still set this header, so this is not a complete
solution. For edge MFA, consider Cloudflare Access (Zero Trust).

### LAN Egress Isolation

Besedy does not currently install host firewall rules that prevent containers
from reaching private LAN addresses. The previous hardcoded-subnet control was
retired after it was found to be silently ineffective, and a dynamic replacement
was rejected because it added substantial fail-open reconciliation complexity.

See [Docker LAN Egress Control Retirement](egress-control-retirement.md) for the
failure analysis, current risk, host cleanup notes, and requirements for a
future design.

### Input Validation

- **Zod schemas** validate all API inputs (`schemas.ts`)
- **Path validation** prevents directory traversal (`path-validation.ts`)
- **Prisma ORM** prevents SQL injection via parameterized queries
- **Hash validation** enforces SHA-256 format (`HashSchema`)

### Secrets Management

All secrets (`AUTH_SECRET`, `DATABASE_URL`, OAuth client secrets) are stored as
environment variables in `.env.prod`. This means they are visible inside the
container. For a home deployment this is acceptable; production-grade
alternatives include Docker secrets (Swarm) or an external secret manager.
Rotate all secrets after any suspected compromise.

### Monitoring and Detection

| Capability                       | Status                                           |
| -------------------------------- | ------------------------------------------------ |
| Audit logging to DB              | Done                                             |
| Docker logs to host syslog       | Done                                             |
| Daily anomaly check + email      | Done (`web/scripts/audit-check.sh`)              |
| Weekly activity report           | Done (`web/scripts/weekly-report.sh`)            |
| Daily host backup coverage check | Done (`web/scripts/host-backup-health-check.sh`) |
| Monthly security update check    | Done (`web/scripts/security-update-check.sh`)    |
| Real-time alerting               | Open (webhook integration not yet wired)         |

For monitoring scripts, schedules, and the update workflow, see
`docs/web/operations.md`.
