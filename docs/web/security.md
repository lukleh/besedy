# Web Security Reference

> **Last Updated:** 2026-04-06

Dense reference for agents working on auth, access control, and deployment
hardening.

- Test accounts: see AGENTS.md (seeded web auth users) and `web/prisma/test-data.ts`
- Audit action types: `AuditAction` enum in `prisma/schema.prisma`
- Path validation: `web/src/lib/security/path-validation.ts`
- Monitoring scripts and schedules: `docs/web/operations.md`

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

| Setting | Value |
|---------|-------|
| Limit | 30 requests per IP |
| Window | 60 seconds |
| Scope | `/api/auth/*` routes |
| Response | `429 Too Many Requests` with `Retry-After: 60` |

Rate limiting is bypassed in dev/test environments.

### Security Headers

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Frame-Options` | `DENY` | Prevent clickjacking |
| `X-Content-Type-Options` | `nosniff` | Prevent MIME sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Control referrer info |
| `X-XSS-Protection` | `1; mode=block` | XSS filter (legacy browsers) |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Disable sensitive APIs |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | HTTPS enforcement (production only) |

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

### Role Hierarchy

| Role | System Access | Catalog Access |
|------|---------------|----------------|
| **Superadmin** | Full control | OWNER (all catalogs) |
| **Admin** | Manage users + catalogs | OWNER (all catalogs) |
| **Owner** | Manage catalog access | OWNER (granted catalogs) |
| **Editor** | -- | EDITOR (granted catalogs) |
| **Member** | -- | MEMBER (granted catalogs) |
| **Viewer** | -- | VIEWER (granted catalogs) |
| **Listener** | -- | LISTENER (granted catalogs) |

Access level hierarchy: `LISTENER < VIEWER < MEMBER < EDITOR < OWNER`

### System-Level Access Matrix

| Feature | Superadmin | Admin | Owner | Editor | Member | Viewer | Listener |
|---------|:----------:|:-----:|:-----:|:------:|:------:|:------:|:--------:|
| Admin Panel | Y | Y | - | - | - | - | - |
| Manage Users | Y | Y | - | - | - | - | - |
| Manage Catalogs | Y | Y | - | - | - | - | - |
| Settings Page | Y | Y | Y* | - | - | - | - |
| Manage Pending Access | Y | Y | Y* | - | - | - | - |

*OWNER can access catalog settings and manage pending grants for catalogs they own.

### Catalog-Level Access Matrix

| Feature | Owner | Editor | Member | Viewer | Listener |
|---------|:-----:|:------:|:------:|:------:|:--------:|
| View Catalog | Y | Y | Y | Y | Y |
| Stream Audio | Y | Y | Y | Y | Y |
| View Transcripts | Y | Y | Y | Y | - |
| Download Audio | Y | Y | Y | - | - |
| Download Transcripts | Y | Y | Y | - | - |
| Edit Metadata | Y | Y | - | - | - |
| Manage Access | Y* | - | - | - | - |
| Manage Pending Access | Y* | - | - | - | - |

*OWNER can grant LISTENER, VIEWER, MEMBER, EDITOR access. Only Admins can
grant OWNER access.

### LISTENER Role

LISTENER is the default access level for new pending catalog grants. Listeners
can access the catalog homepage and stream audio but **cannot view transcripts**.
The catalog homepage is events-first for listeners; recording detail access
follows listener recording visibility rules.

### Access Management Rules

**OWNER capabilities:**

- View and manage catalog settings for their catalogs
- Grant LISTENER, VIEWER, MEMBER, or EDITOR access
- Update non-OWNER access levels
- Revoke non-OWNER access
- Create and revoke pending catalog grants (non-OWNER levels)

**OWNER restrictions:**

- Cannot grant OWNER access (Admin only)
- Cannot modify existing OWNER access (Admin only)
- Cannot revoke OWNER access (Admin only)
- Cannot demote or revoke their own access

**Why OWNER cannot grant OWNER:** This prevents privilege escalation chains. An
Owner could otherwise grant Owner to another user, who could then propagate
Owner further, rapidly expanding access without admin oversight.

### CatalogAccess Retention for Blocked Users

When a user is blocked, their `CatalogAccess` records are **retained**. Access
is denied at runtime via user status checks. This allows easy restoration of
previous access when unblocking.

### Capability Helpers

Prefer the typed capability layer over older ad hoc permission helpers:

| Helper | Scope |
|--------|-------|
| `getPortalCapability()` | Portal admission and top-level access |
| `getAdminCapability()` | Admin surfaces |
| `getCatalogCapability()` | Catalog-scoped access |
| `getRecordingCapability()` | Recording-scoped access |
| `requireCatalogEventsAccess()` | Event visibility and edit checks |

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

| Aspect | Value |
|--------|-------|
| Environment | Single host running Docker Compose |
| Network | Cloudflare Tunnel (outbound-only, no inbound ports) |
| TLS | Cloudflare terminates TLS, provides DDoS protection |
| Goal | Reasonable security, minimal blast radius on container compromise |

When this guide references `.env.prod`, read that as the resolved production
env file (`BESEDY_WEB_ENV_PROD` or `~/.config/lukleh/besedy/web.env.prod`).

### Container Hardening Checklist

| Control | Status | Source |
|---------|:------:|--------|
| Non-root user (UID 1001) | Done | `Dockerfile` |
| Read-only data mount (`:ro`) | Done | `docker-compose.secure.yml` |
| Localhost-only port (`127.0.0.1:3000`) | Done | `docker-compose.secure.yml` |
| DB user split (`besedy_migrator` DDL / `besedy_app` DML) | Done | Host-only migrator, container app user |
| Read-only container filesystem + tmpfs | Done | `docker-compose.secure.yml` |
| `cap_drop: ALL` | Done | `docker-compose.secure.yml` |
| `no-new-privileges: true` | Done | `docker-compose.secure.yml` |
| Resource limits (2 CPU, 1 GB RAM) | Done | `docker-compose.secure.yml` |
| Syslog logging | Done | Docker logs to host syslog |
| Egress controls (LAN blocked) | Done | `web/setup/egress/` + systemd service |
| Cloudflare Tunnel (outbound-only) | Done | No listening port to attack |

### Container Escape Vectors

| Vector | Risk | Mitigation |
|--------|------|------------|
| Kernel exploit | Low | Alpine is minimal but not hardened |
| Docker socket | None | Not mounted |
| Host filesystem | None | Only `/data` (read-only), container FS read-only |
| Privilege escalation | Very Low | UID 1001, all caps dropped, no-new-privileges |
| Network pivot to LAN | Low | RFC 1918 blocked via iptables |
| Network pivot to Internet | Medium | Internet allowed for OAuth |

### Blast Radius: Web Container Compromised

**What an attacker CAN do:**

| Access | Detail |
|--------|--------|
| Read audio/transcripts | `/data` mounted read-only |
| Full DB read/write | Via `DATABASE_URL` env var |
| Network to DB container | Docker network |
| Exfiltrate data | Outbound internet (required for OAuth) |
| Delete audit logs | Via database access |

**What an attacker CANNOT do:**

| Blocked | Why |
|---------|-----|
| Write to audio files | Read-only mount |
| Access host filesystem | No host mounts beyond `/data` |
| Access other containers' filesystems | No shared volumes, no Docker socket |
| Escape to host | No privileged mode, no capabilities |
| Access cloudflared credentials | Stored on host, not in container |
| Scan/attack LAN devices | RFC 1918 ranges blocked via iptables |

### Lateral Movement Summary

| Path | Method | Risk |
|------|--------|------|
| web -> db | `DATABASE_URL` env var | High (full DB) |
| web -> backup | None (no shared creds) | Low |
| web -> host | No escape vector | Low |
| web -> cloudflared | Runs on host | Low |
| web -> LAN | iptables DROP on RFC 1918 | Blocked |
| web -> Internet | Outbound TCP/HTTP | Medium (OAuth) |

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

### Egress Controls

Containers cannot reach private IP ranges (RFC 1918): `10.0.0.0/8`,
`172.16.0.0/12` (except Docker's own subnet), `192.168.0.0/16`. Inter-container
traffic (web to db) is allowed. Internet is allowed (required for Google OAuth).
Rules are applied by `web/setup/egress/iptables-egress.sh` and persisted via
`besedy-egress.service` (systemd, runs at boot).

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

| Capability | Status |
|------------|--------|
| Audit logging to DB | Done |
| Docker logs to host syslog | Done |
| Daily anomaly check + email | Done (`web/scripts/audit-check.sh`) |
| Weekly activity report | Done (`web/scripts/weekly-report.sh`) |
| Daily host backup coverage check | Done (`web/scripts/host-backup-health-check.sh`) |
| Monthly security update check | Done (`web/scripts/security-update-check.sh`) |
| Real-time alerting | Open (webhook integration not yet wired) |

For monitoring scripts, schedules, and the update workflow, see
`docs/web/operations.md`. Egress hardening assets live in
`web/setup/egress/`.
