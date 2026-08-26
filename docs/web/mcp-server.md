# Besedy MCP Server

> Status: authenticated read surface implemented

## Local smoke test

Run the MCP server against the disposable test database and mock OAuth provider,
never production:

```bash
just mcp-smoke
```

The test signs in as the seeded catalog owner through the mock OAuth UI, accepts
the MCP consent screen, exchanges an authorization code with PKCE, validates
the audience-bound JWT, sends MCP 2026-07-28 `tools/list`, and calls
all six tools. It verifies default-catalog resolution, the owner's live
capability flags, metadata reads, bounded transcript pagination, and a grounded
RAG result from a deterministic test-only ColBERT mock. Catalog-scoped calls do
not supply `catalogId`, so the same run covers default selection. The test keeps
the test containers running for reuse; stop them with `just test-down`. On a
new machine, install the Playwright browser once with
`cd web && npx playwright install chromium`.

> Last updated: 2026-08-26

## Purpose and scope

Besedy exposes a remote, read-only Model Context Protocol (MCP) server from the
web service. It lets an authenticated AI client discover catalogs and events,
read event/recording metadata and transcripts, and use Besedy transcript search.

The first version deliberately does **not** expose audio bytes, storage paths,
mutations, administrative operations, or background-job controls.

The implementation uses the stable `@modelcontextprotocol/server` **2.x** SDK
and the MCP 2026-07-28 protocol. Do not replace it with the legacy
`@modelcontextprotocol/sdk` package or the v1 compatibility server.

## Architectural rule: one policy, two delivery surfaces

Web pages, web API routes, and MCP tools must all call the same policy and
capability functions in `web/src/lib/policy` and `web/src/lib/access`. Role or
release checks must not be reimplemented in MCP handlers, UI components, or
database query fragments.

The boundary is:

```text
authenticated user
       |
       v
canonical actor + catalog/event/recording policy
       |
       v
shared event/recording/transcript/search read services
       |
       +---- web UI and web API serializers
       |
       +---- MCP tool discovery and agent-oriented serializers
```

This makes a future policy change (for example, hiding unreleased events from
VIEWER) apply to both surfaces. Tests must exercise the canonical policy and
assert representative web and MCP behavior against it. Documentation describes
the policy, but the policy code is authoritative.

## Authentication and transport

- Endpoint: `POST /api/mcp` over HTTPS in production.
- Authentication: OAuth 2.1 authorization through the existing Better Auth
  installation. A client authorization ultimately uses the same Google sign-in,
  Besedy admission, user status, and session rules as the web application.
- Tokens: short-lived, audience-bound JWT access tokens validated by the MCP
  endpoint.
- OAuth client registration supports both mechanisms needed by remote clients:
  Client ID Metadata Documents (CIMD) for MCP 2026-07-28 clients such as Codex,
  and RFC 7591 Dynamic Client Registration (DCR) as a compatibility fallback
  for clients such as Claude. Both are discovery-driven; users do not create or
  paste Besedy API keys.
- DCR registration is open because an MCP client must register before a user is
  signed in. Registration creates only an OAuth application identity and grants
  no Besedy access. Public clients must use S256 PKCE, redirect URIs are matched
  exactly, the client remains limited to configured scopes and the canonical
  MCP resource, the user must still sign in and consent, and the existing auth
  endpoint rate limit applies.
- Co-located Docker deployments validate JWT signatures through the
  process-local `BESEDY_MCP_JWKS_URL` (default
  `http://127.0.0.1:3000/api/auth/jwks`). The token issuer and audience remain
  the public `AUTH_URL` and MCP resource URL. A non-container deployment may
  omit this variable and use the public JWKS URL.
- Discovery: OAuth authorization-server and protected-resource metadata are
  published for remote MCP clients.
- Transport: stateless Streamable HTTP. Legacy MCP transport requests are
  rejected.
- Every tool call resolves the current user and current grants again. A token
  never freezes catalog permissions for its lifetime.
- Production enablement is explicit: set `BESEDY_MCP_ENABLED=true` only with a
  canonical HTTPS `AUTH_URL`. MCP defaults to disabled in production and
  enabled in development. Disabled deployments return 404 from MCP and its
  discovery/login/consent routes and do not install the OAuth-provider plugins.
- After OAuth validation, the endpoint applies per-process authenticated-global,
  OAuth-client, and user rate limits. Anonymous traffic does not consume those
  authenticated buckets. Deployment-level anonymous/IP limiting is still
  recommended, as is distributed limiting for multi-instance installations.

`PENDING`, `BLOCKED`, deleted, or otherwise inactive users cannot use MCP even
if they previously obtained a token. Revoked catalog grants stop authorizing
catalog data on the next call.

### Remote client setup

With the production `AUTH_URL` set to `https://besedy.org`, the public
Streamable HTTP endpoint is `https://besedy.org/api/mcp`. Clients discover the
OAuth endpoints and choose CIMD or DCR automatically.

Codex CLI:

```bash
codex mcp add besedy --url https://besedy.org/api/mcp
codex mcp login besedy
```

Claude Code:

```bash
claude mcp add --transport http --scope user besedy https://besedy.org/api/mcp
claude mcp login besedy
```

The interactive Claude Code `/mcp` menu can start the same login. In Claude or
Claude Desktop, add a custom web connector under **Settings → Connectors** and
use the same endpoint URL. In every client, the browser flow signs the user into
Besedy through Google and displays the Besedy MCP consent screen. No bearer
token or Google credential is pasted into the client configuration.

## Access matrix

The table is the intended read surface for an active user. `ADMIN` includes
superadmins. A dash means the capability is not available.

| User/catalog relationship |        List catalog |      List/get event | See unreleased event | Get recording metadata | Get transcript | Search transcripts |
| ------------------------- | ------------------: | ------------------: | -------------------: | ---------------------: | -------------: | -----------------: |
| No grant                  |                  No |                  No |                   No |                     No |             No |                 No |
| `LISTENER`                |                 Yes | Released/ready only |                   No |   Published/ready only |             No |                 No |
| `VIEWER`                  |                 Yes |                 Yes |                  Yes |                    Yes |            Yes |                Yes |
| `MEMBER`                  |                 Yes |                 Yes |                  Yes |                    Yes |            Yes |                Yes |
| `EDITOR`                  |                 Yes |                 Yes |                  Yes |                    Yes |            Yes |                Yes |
| `OWNER`                   |                 Yes |                 Yes |                  Yes |                    Yes |            Yes |                Yes |
| `ADMIN`                   | All active catalogs |                 Yes |                  Yes |                    Yes |            Yes |                Yes |

For a `LISTENER`, an event is visible only when all of these are true:

1. the event is released;
2. its primary recording is actionable/ready; and
3. its primary recording is published.

Listener-visible attached recordings are likewise restricted to actionable,
published recordings. `VIEWER` and higher currently see unreleased events. If
that rule changes in the canonical event policy, both web and MCP inherit the
new result.

Portal status is evaluated before catalog role. Unauthenticated, `PENDING`, and
`BLOCKED` users receive no protected MCP tools or data. An active user with no
catalog grants can authenticate but only gets an empty catalog list.

## Tool discovery and per-call authorization

MCP tool discovery is personalized from the union of a user's live catalog
capabilities:

- Every active user gets `list_catalogs`.
- Event and recording tools are exposed if at least one accessible catalog
  permits that operation.
- `get_transcript` and `search_transcripts` are omitted for a user who is only a
  `LISTENER` everywhere.

A user may be a listener in one catalog and a viewer in another. Tool discovery
therefore cannot by itself authorize an invocation. Every tool still checks the
resolved target catalog and returns a permission error if that particular
catalog does not allow the requested operation.

`list_catalogs` includes the explicit `catalogGrant`, the `isCatalogAdmin`
system-authority flag, and booleans such as `canViewTranscripts`,
`canSearchTranscripts`, and `canSeeUnreleasedEvents`, so an agent can select
valid operations without guessing from role names. It also distinguishes the
user's saved default, the configured global default, and the effective default
that an omitted `catalogId` will resolve.

## Initial tools

All tools are annotated read-only and return structured JSON plus concise text.
Results contain stable Besedy identifiers and web URLs where useful, but never
filesystem paths or audio URLs.

| Tool                 | Purpose                                                       | Minimum catalog capability          |
| -------------------- | ------------------------------------------------------------- | ----------------------------------- |
| `list_catalogs`      | List accessible catalogs and their capabilities               | Active portal user                  |
| `list_events`        | Page/filter visible events and their metadata                 | Catalog access                      |
| `get_event`          | Get one visible event and paged recording summaries           | Catalog access and event visibility |
| `get_recording`      | Get metadata for one visible recording                        | Recording visibility                |
| `get_transcript`     | Get a recording transcript, optionally by time/segment window | `canViewTranscripts`                |
| `search_transcripts` | Run existing Besedy RAG search and return grounded matches    | `canSearchTranscripts`              |

`list_catalogs` accepts an optional cursor and a `limit` from 1 to 100 (default
50). Its response includes `nextCursor`, `defaultCatalogId`, and
`defaultCatalogSource`. Catalog entries expose `isUserDefault`,
`isGlobalDefault`, and `isEffectiveDefault` separately. The default source is
one of `user_preference`, `global_default`, `most_recent`, or `null`. An invalid
cursor returns the standard structured `invalid_cursor` tool error.

`list_events` accepts an optional numeric cursor, release-state and
title/description/location filters, and a limit from 1 to 100 (default 25).
Each event includes its authenticated Besedy `webUrl`, a compact primary
recording summary, and a `recordingCount` scoped to recordings visible to the
caller. `get_event` takes an event ID plus an optional `recordingOffset`
(default 0) and `recordingLimit` from 1 to 100 (default 25). It returns the
event's authenticated `webUrl` and a permission-scoped recording page with
`items`, `totalVisible`, and `nextOffset`; each compact recording summary also
has an authenticated `webUrl`. Recording and transcript reads use the stable
audio hash. `get_recording` accepts an optional `eventOffset` (default 0) and
`eventLimit` from 1 to 100 (default 25). It returns detailed metadata with an
authenticated recording `webUrl` and a permission-scoped event page containing
`items`, `totalVisible`, and `nextOffset`; every linked event also has a
`webUrl`. `get_transcript` accepts a half-open time range through `startSec`
(inclusive) and `endSec` (exclusive), plus `segmentOffset`, `segmentLimit`, and
`maxTextChars`. Defaults cap each response at 50 segments and approximately
20,000 transcript characters; accepted input maxima are 200 segments and
50,000 characters. Segment boundaries are preserved, so a single unusually
large segment may exceed the requested character target. Each result includes
the authenticated recording `webUrl`, the
selected and available backends, and a segment page with absolute
`segmentIndex` values, `totalMatching`, and `nextOffset`. Search accepts up to
1,000 query characters and returns at most 20 grounded matches per call.
`contextChunks` controls zero to three surrounding chunks, while optional
`maxPerRecording` diversifies results. Search also exposes the web UI's audio
hash, location, recorder, year, and verification filters. Results contain a
compact recording summary, an exact match with a seekable `webUrl`, optional
before/after context without repeating the exact match, metadata, a stable
citation, and, when a stored transcript is available, a ready-to-call
`transcriptRequest` using the actual stored backend. The citation continues to
identify the RAG backend used for retrieval.
Search is explicitly marked semantic and non-exhaustive, and defaults to at
most three results per recording for corpus diversity. Transcript pages return
a `continuation` object that preserves their catalog, backend, range, limits,
and next offset. Both tools render the actual evidence text in standard MCP
`content` as well as structured JSON for broad client compatibility. Agents
should normally search first, then fetch only the relevant transcript range. An
unavailable RAG service returns the structured `search_unavailable` error; a
catalog without a search bundle returns the non-retryable
`search_not_configured` error. Every structured tool error includes a boolean
`retryable`; agents may automatically retry only errors where it is `true`.

Pagination, limits, and transcript windows are mandatory safeguards; tools must
not return an unbounded catalog or transcript collection.

## Optional catalog selection

Catalog-scoped tools accept an optional `catalogId`. When it is absent, Besedy
resolves a catalog without changing user preferences, in this order:

1. the user's saved active/default catalog, if still accessible;
2. the configured global default catalog, if accessible;
3. the most recently accessible catalog; and
4. for an administrator only, the administrator fallback catalog.

An explicit `catalogId` is checked for access and used only for that call. MCP
reads never change the default catalog stored by the web UI. If no accessible
catalog can be resolved, the tool returns a clear `catalog_required` error.

## Error and data rules

- Use not-found semantics when revealing the existence of an inaccessible
  event or recording would leak information.
- Use a permission error for an accessible catalog whose role does not allow a
  known capability such as transcripts.
- Keep error messages capability-oriented rather than naming a particular role;
  canonical policy is the source of truth for which roles grant a capability.
- Do not include transcript content in logs, metrics, OAuth claims, or errors.
- Enforce server-side result limits even when a client supplies a larger value.
- Search results must pass the same catalog and recording policy as direct reads.
- MCP code calls reusable application services; it must not call Besedy's own
  HTTP routes or duplicate their queries.

## Implementation checklist

### Foundation

- [x] Confirm current role, event-release, recording, transcript, and search policy.
- [x] Select MCP TypeScript SDK v2 and Better Auth MCP/OAuth integration.
- [x] Define the access matrix, personalized discovery, and optional catalog rules.
- [x] Make RAG permission derive from transcript permission in canonical policy.
- [x] Add a side-effect-free default catalog resolver for service/MCP reads.
- [x] Share event visibility/detail and canonical recording read models beneath
      web and MCP serializers; reuse the existing transcript and RAG search services.

### OAuth and remote transport

- [x] Add Better Auth JWT, MCP authorization-server, and CIMD plugins.
- [x] Add the required Prisma OAuth/JWT schema migration and OAuth replay storage.
- [x] Add Google-backed MCP login and consent continuation pages.
- [x] Support CIMD plus a PKCE-protected DCR fallback for remote clients.
- [x] Publish OAuth discovery/protected-resource metadata.
- [x] Mount authenticated, stateless `POST /api/mcp`; reject legacy transport.
- [x] Exempt the enabled bearer-only MCP endpoint from browser CSRF checks so
      unauthenticated clients can receive the OAuth challenge.

### MCP surface

- [x] Register tools dynamically from live aggregate capabilities.
- [x] Implement `list_catalogs` and side-effect-free catalog resolution.
- [x] Implement paginated `list_events`, `get_event`, and `get_recording`.
- [x] Implement bounded `get_transcript`.
- [x] Connect `search_transcripts` to the existing RAG search service.
- [x] Ensure structured outputs omit audio URLs, paths, and private fields.

### Verification and rollout

- [x] Unit-test the complete access matrix, including mixed catalog roles.
- [ ] Contract-test tool discovery and every tool's per-catalog authorization.
- [ ] Integration-test OAuth discovery, Google login continuation, consent, and token validation.
- [ ] Regression-test web event/search behavior against canonical policy.
- [x] Add initial global/client/user MCP rate limits and bound `list_catalogs`.
- [x] Gate production enablement with `BESEDY_MCP_ENABLED` and strict `AUTH_URL` validation.
- [ ] Add audit events, deployment-level limits, and safe metrics.
- [x] Document client registration and authentication behavior.

## Change checklist for permissions

Any access-level change is incomplete until all of these are true:

1. change the canonical policy function;
2. update its matrix/table-driven tests;
3. verify the web API/UI consumes the resulting capability;
4. verify MCP discovery and invocation consume the same capability;
5. update this descriptive matrix; and
6. run type checks and the web/MCP authorization suites.
