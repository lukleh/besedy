# Besedy MCP Server

> Status: initial authenticated `list_catalogs` vertical slice implemented

## Local smoke test

Run the MCP server against the disposable test database and mock OAuth provider,
never production:

```bash
just mcp-smoke
```

The test signs in as the seeded catalog owner through the mock OAuth UI, accepts
the MCP consent screen, exchanges an authorization code with PKCE, sends MCP
2026-07-28 `tools/list`, and calls `list_catalogs`. It verifies the effective
default catalog and the owner's live capability flags. The test keeps the test
containers running for reuse; stop them with `just test-down`. On a new
machine, install the Playwright browser once with
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
       +---- web UI and web API
       |
       +---- MCP tool discovery and tool execution
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
  endpoint. Dynamic client registration follows the MCP CIMD profile.
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
- The initial endpoint applies per-process global, OAuth-client, and user rate
  limits. Deployment-level rate limiting is still recommended for multi-instance
  installations.

`PENDING`, `BLOCKED`, deleted, or otherwise inactive users cannot use MCP even
if they previously obtained a token. Revoked catalog grants stop authorizing
catalog data on the next call.

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

`list_catalogs` includes the effective role and explicit booleans such as
`canViewTranscripts`, `canSearchTranscripts`, and `canSeeUnreleasedEvents`, so an
agent can select valid operations without guessing from role names. It also
distinguishes the user's saved default, the configured global default, and the
effective default that an omitted `catalogId` will resolve.

## Initial tools

All tools are annotated read-only and return structured JSON plus concise text.
Results contain stable Besedy identifiers and web URLs where useful, but never
filesystem paths or audio URLs.

The currently implemented vertical slice is `list_catalogs`. The remaining
tools stay intentionally undiscoverable until their shared application services
and authorization tests are complete.

| Tool                 | Purpose                                                       | Minimum catalog capability          |
| -------------------- | ------------------------------------------------------------- | ----------------------------------- |
| `list_catalogs`      | List accessible catalogs and their capabilities               | Active portal user                  |
| `list_events`        | Page/filter visible events and their metadata                 | Catalog access                      |
| `get_event`          | Get one visible event and attached recording metadata         | Catalog access and event visibility |
| `get_recording`      | Get metadata for one visible recording                        | Recording visibility                |
| `get_transcript`     | Get a recording transcript, optionally by time/segment window | `canViewTranscripts`                |
| `search_transcripts` | Run existing Besedy RAG search and return grounded matches    | `canUseRagSearch`                   |

`list_catalogs` accepts an optional cursor and a `limit` from 1 to 100 (default
50). Its response includes `nextCursor`, `defaultCatalogId`, and
`defaultCatalogSource`. Catalog entries expose `isUserDefault`,
`isGlobalDefault`, and `isEffectiveDefault` separately.

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
- [ ] Extract shared event, recording, transcript, and search services from routes.

### OAuth and remote transport

- [x] Add Better Auth JWT, MCP authorization-server, and CIMD plugins.
- [x] Add the required Prisma OAuth/JWT schema migration and OAuth replay storage.
- [x] Add Google-backed MCP login and consent continuation pages.
- [x] Publish OAuth discovery/protected-resource metadata.
- [x] Mount authenticated, stateless `POST /api/mcp`; reject legacy transport.
- [x] Exempt only the bearer-authenticated MCP endpoint from browser CSRF checks.

### MCP surface

- [ ] Register tools dynamically from live aggregate capabilities.
- [x] Implement `list_catalogs` and side-effect-free catalog resolution.
- [ ] Implement paginated `list_events`, `get_event`, and `get_recording`.
- [ ] Implement bounded `get_transcript`.
- [ ] Connect `search_transcripts` to the existing RAG search service.
- [ ] Ensure structured outputs omit audio URLs, paths, and private fields.

### Verification and rollout

- [x] Unit-test the complete access matrix, including mixed catalog roles.
- [ ] Contract-test tool discovery and every tool's per-catalog authorization.
- [ ] Integration-test OAuth discovery, Google login continuation, consent, and token validation.
- [ ] Regression-test web event/search behavior against canonical policy.
- [x] Add initial global/client/user MCP rate limits and bound `list_catalogs`.
- [x] Gate production enablement with `BESEDY_MCP_ENABLED` and strict `AUTH_URL` validation.
- [ ] Add audit events, deployment-level limits, and safe metrics.
- [ ] Document client setup after the remaining read tools are implemented.

## Change checklist for permissions

Any access-level change is incomplete until all of these are true:

1. change the canonical policy function;
2. update its matrix/table-driven tests;
3. verify the web API/UI consumes the resulting capability;
4. verify MCP discovery and invocation consume the same capability;
5. update this descriptive matrix; and
6. run type checks and the web/MCP authorization suites.
