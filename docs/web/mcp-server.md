# Besedy MCP Server

> Status: authenticated read surface implemented
>
> Last updated: 2026-09-02

This document covers the design of the MCP server: scope, architecture,
authentication, access rules, catalog resolution, telemetry, testing, and the
change checklist. The per-tool contract lives in [mcp-tools.md](mcp-tools.md).
Deferred work is tracked in [mcp-follow-ups.md](mcp-follow-ups.md). Client
setup instructions live in the [repository README](../../README.md#ai-agent-access-mcp).

## Purpose and scope

Besedy exposes a remote, read-only Model Context Protocol (MCP) server from the
web service. It lets an authenticated AI client discover catalogs and events,
read event/recording metadata and transcripts, and use Besedy transcript search.

The first version deliberately does **not** expose audio bytes, storage paths,
mutations, administrative operations, or background-job controls.

The implementation uses the stable `@modelcontextprotocol/server` **2.x** SDK
and the MCP 2026-07-28 protocol. Do not replace it with the legacy
`@modelcontextprotocol/sdk` package or the v1 compatibility server.

## Architectural rule: shared visibility, surface-specific capabilities

Web pages, web API routes, and MCP tools share the canonical listener visibility
rules in `web/src/lib/policy` and `web/src/lib/catalog-events`: released events
and published, actionable recordings. Web roles continue to determine web
capabilities. MCP applies a separate, uniform read capability after catalog
membership is established, adding transcript reads and search without widening
listener visibility.

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

Tests must exercise the canonical listener visibility and assert representative
web and MCP behavior against it. Documentation describes the policy, but the
policy code is authoritative.

## Reference pattern for MCP tools

`who_am_i` is the smallest reference implementation for how an MCP tool should
combine authentication, current state, shared web policy, and response
serialization:

1. **Refresh authorization for every request.** The MCP route validates the
   token subject, OAuth client, resource, current consent, and current portal
   access. For consented clients, effective scopes are the intersection of the
   token claims and live consent, so an old token cannot preserve a scope the
   user has revoked. Current portal access is required for every client.
2. **Use canonical catalog membership.** `getMcpAccessProfile` obtains the
   current actor, system role, catalog grants, and defaults through the same
   access queries used by the web application. Every accessible catalog receives
   the uniform MCP capability set.
3. **Keep identity data separate from authorization.** `getMcpIdentity` loads
   only account and OAuth-client display data. `who_am_i` takes the default
   catalog from the access profile rather than treating identity fields as
   permission facts.
4. **Gate catalogs and returned fields.** Every active account receives every
   tool, but each invocation must still authorize its resolved catalog and apply
   listener visibility. Response serialization must also enforce OAuth scopes:
   `profile` controls the account name, while `email` controls the email field.
   Expose only fields an agent needs for the documented workflow; internal
   flags, roles, and index bookkeeping stay out of tool results.
5. **Share one policy snapshot inside the tool request.** The transport is
   stateless, so the next HTTP request rebuilds current policy state. Within a
   request, `BesedyMcpRequestContext` carries the client, effective scopes, and
   access profile into the server; the user comes from that profile rather than
   a second field that could disagree. Handlers reuse the profile instead of
   fetching or reconstructing the same authorization facts.
6. **Fail without leaking protected data.** Expected races and revocations use
   structured tool errors. For example, if the authenticated account disappears
   before `who_am_i` loads its display data, the tool returns
   `identity_unavailable` and no partial identity.

New tools should follow the same division: the route establishes live OAuth and
portal authorization, the access profile limits catalog membership, shared read
services apply listener visibility, and the MCP handler shapes the agent-facing
result. Tests should cover discovery, direct invocation, scope-gated fields, a
denied catalog or hidden resource, and the tool's structured failure paths.

Each tool lives in its own registrar module under
`web/src/lib/mcp/tools/`. `server.ts` only creates the server and registers the
uniform tool set. Shared catalog resolution and structured success/error
handling live in `tools/shared.ts` so tools cannot drift into different
not-found or retry semantics.
Keep tool-specific schemas, defaults, service calls, and response rendering in
the tool's module; do not move policy derivation or raw database authorization
queries there.

## Authentication and transport

- Endpoint: `POST /api/mcp` over HTTPS in production. Authenticated and
  unauthenticated `GET /api/mcp` requests pass through the same OAuth guard so
  legacy clients can discover the protected-resource metadata from its bearer
  challenge; the stateless MCP handler still rejects authenticated GET serving.
- Authentication: OAuth 2.1 authorization through the existing Better Auth
  installation. A client authorization ultimately uses the same Google sign-in,
  Besedy admission, user status, and session rules as the web application.
- MCP account admission is a strict subset of Besedy portal admission. A person whose email is not on
  the preallowed users list cannot create a Besedy account or session through the
  MCP authorization flow and therefore cannot authorize an MCP client. The
  configured superadmin bootstrap account is the same explicit exception used by
  the web application.
- A pending admission is marked `CLAIMED` when the user first signs in. After
  that claim, every MCP request checks the user's current Besedy portal status,
  and every tool invocation checks current catalog grants and resource policy.
  Blocking a user from Besedy therefore also blocks MCP access; an old OAuth
  token does not bypass that check.
- Tokens: short-lived, audience-bound JWT access tokens validated by the MCP
  endpoint. The authorization server stores a hash of every issued MCP access
  token, links it to its refresh family, and requires that live row on every MCP
  request. Explicit token revocation and refresh-family invalidation therefore
  take effect immediately rather than waiting for JWT expiry. Access tokens
  issued before this stored-token enforcement was deployed have no registry row
  and receive an `invalid_token` challenge; clients must refresh or reconnect
  once during the rollout.
- Deleting an OAuth consent also revokes every refresh token for that user and
  client, so authorizing the client again cannot revive an older connection.
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
  endpoint rate limit applies. Redirect URIs are exact after the supported
  loopback-host normalization required by compatible native clients.
- Consent and sign-in pages show the client name and exact client ID. HTTPS
  Client ID Metadata Documents also show their metadata origin; dynamically
  registered clients are explicitly labeled as lacking a verified web origin.
- Co-located Docker deployments validate JWT signatures through the
  process-local `BESEDY_MCP_JWKS_URL` (default
  `http://127.0.0.1:3000/api/auth/jwks`). The token issuer and audience remain
  the public `AUTH_URL` and MCP resource URL. A non-container deployment may
  omit this variable and use the public JWKS URL.
- Discovery: OAuth authorization-server and protected-resource metadata are
  published for remote MCP clients.
- Transport: stateless Streamable HTTP. The MCP SDK v2 handler serves both its
  current protocol and the stateless 2025 protocol used by clients such as
  Codex from the same server factory, so tool definitions and authorization
  cannot drift between protocol generations.
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
catalog data on the next call. Web access levels and web UI behavior are not
changed by the MCP policy.

### Remote client setup

With the production `AUTH_URL` set to `https://besedy.org`, the public
Streamable HTTP endpoint is `https://besedy.org/api/mcp`. Clients discover the
OAuth endpoints and choose CIMD or DCR automatically. The per-client commands
for Codex, Claude Code, and Claude connectors are kept in one place, the
[repository README](../../README.md#ai-agent-access-mcp), so they do not drift. In every
client, the browser flow signs the user into Besedy through Google and displays
the Besedy MCP consent screen. No bearer token or Google credential is pasted
into the client configuration.

## Access matrix

The table is the intended MCP read surface for an active user. `ADMIN` includes
superadmins. Every active account receives all tools; catalog grants determine
which catalogs contain readable data.

| User/catalog relationship |        List catalog |      List/get event | See unreleased event | Get recording metadata |             Get transcript |                              Search transcripts |
| ------------------------- | ------------------: | ------------------: | -------------------: | ---------------------: | -------------------------: | ----------------------------------------------: |
| No grant                  |                  No |                  No |                   No |                     No |                         No |                                              No |
| `LISTENER`                |                 Yes | Released/ready only |                   No |   Published/ready only | Published/ready recordings | Released events with published/ready recordings |
| `VIEWER`                  |                 Yes | Released/ready only |                   No |   Published/ready only | Published/ready recordings | Released events with published/ready recordings |
| `MEMBER`                  |                 Yes | Released/ready only |                   No |   Published/ready only | Published/ready recordings | Released events with published/ready recordings |
| `EDITOR`                  |                 Yes | Released/ready only |                   No |   Published/ready only | Published/ready recordings | Released events with published/ready recordings |
| `OWNER`                   |                 Yes | Released/ready only |                   No |   Published/ready only | Published/ready recordings | Released events with published/ready recordings |
| `ADMIN`                   | All active catalogs | Released/ready only |                   No |   Published/ready only | Published/ready recordings | Released events with published/ready recordings |

For a `LISTENER`, an event is visible only when all of these are true:

1. the event is released;
2. its primary recording is actionable/ready; and
3. its primary recording is published.

Listener-visible attached recordings are likewise restricted to actionable,
published recordings. Direct recording metadata and transcript reads also
require a link to at least one listener-visible released event. MCP applies this
visibility at every catalog access level; higher web roles do not expose
unreleased data through MCP.

Portal status is evaluated before catalog role. Unauthenticated, `PENDING`, and
`BLOCKED` users receive no protected MCP tools or data. An active user with no
catalog grants receives all tools but gets an empty catalog list and cannot read
catalog-scoped data.

### Design decision: listener transcript access through MCP

A `LISTENER` grant cannot open transcript text or transcript search in the web
UI, yet the same grant can read and search transcripts through MCP. This is a
deliberate decision, not an oversight, and it was confirmed on 2026-09-02.

The reasoning: reading a transcript as a document and having an agent consult it
are different uses. The web transcript view hands a person the full text of a
recording to read like a book. Through MCP, the transcript is background
knowledge that an agent draws on while answering the user's own questions about
Besedy; the person sees grounded answers and bounded, citable excerpts, not the
text as a whole. Listener visibility still applies in full: released events and
published, actionable recordings only, with no widening for higher web roles.

Consequences to keep in mind when changing either surface:

- MCP transcript access is not a strict subset of web transcript access. Do not
  "fix" the web denial by pointing at MCP or vice versa.
- If a catalog ever needs transcripts withheld from listeners on both surfaces,
  that is a new MCP capability rule, not a listener-visibility change.
- The optional web role gate `canViewCatalogTranscripts` is intentionally not
  consulted by MCP reads. Tests that assert listener transcript access through
  MCP are asserting this decision, not a bug.

## Tool discovery and per-call authorization

Every active user receives all ten tools. Tool discovery does not authorize an
invocation: every catalog-scoped call still checks that the resolved target is
in the user's live accessible catalog list. An inaccessible catalog uses
not-found semantics.

`list_catalogs` includes `isDefault` for the effective default that an omitted
`catalogId` will resolve. Web roles and system authority do not change MCP
behavior, so they are not repeated on every catalog; the uniform MCP
capabilities are expressed by the discovered tool set and access rules.

## Tool reference

The per-tool contract, including arguments, result shapes, rendered text,
examples, and error codes, lives in [mcp-tools.md](mcp-tools.md). The code is
authoritative: input schemas sit in each registrar under
`web/src/lib/mcp/tools/`, output schemas in
`web/src/lib/mcp/tools/output-schemas.ts`, and both are advertised live through
`tools/list`. Change the code, the tool reference, and the tests in the same
pull request.

## Optional catalog selection

Catalog-scoped tools accept an optional `catalogId`. When it is absent, Besedy
resolves a catalog without changing user preferences, in this order:

1. the user's saved active/default catalog, if still accessible;
2. the configured global default catalog, if accessible;
3. the most recently accessible catalog.

An explicit `catalogId` is checked for access and used only for that call. MCP
reads never change the default catalog stored by the web UI. If no accessible
catalog can be resolved, the tool returns a clear `catalog_required` error.

## Error and data rules

- Use not-found semantics when revealing the existence of an inaccessible
  event or recording would leak information.
- Do not include transcript content in logs, metrics, OAuth claims, or errors.
- Enforce server-side result limits even when a client supplies a larger value.
- Search results must pass the same catalog-membership and listener-visibility
  policy as direct reads.
- MCP code calls reusable application services; it must not call Besedy's own
  HTTP routes or duplicate their queries.

## Usage telemetry

Every authenticated tool handler is registered through the shared tracked-tool
wrapper. It writes one `mcp_tool_invocation` row with the user, OAuth client,
tool, resolved catalog where applicable, outcome, duration, and returned
transcript character count. The admin view at `/admin/mcp` shows
these calls by time, tool, user, client, and catalog. The weekly operator email
contains the same high-level MCP activity summary.

Raw invocations are retained for 180 days by
`mcp-usage-retention.sh`. Before deletion they are merged into daily aggregate
rows. The aggregates are retained for 400 days, keeping the 12-month dashboard
complete while bounding actor and tool usage data retention. The immutable actor
ID is retained in both raw and aggregate rows, while the optional live `User`
relation may be cleared by account deletion.

Telemetry must never contain bearer or refresh tokens, raw search queries,
transcript text, complete tool arguments, or response content. Search usage
records no query or filter details; transcript reads record only returned
character counts. MCP request denials are also mirrored into `audit_log` as
security events with `resource = 'mcp'`. A telemetry-write failure is logged but
must not change the MCP tool result.

## Change checklist for access

An MCP access change is incomplete until all of these are true:

1. preserve active-account enforcement at the OAuth boundary;
2. preserve live catalog membership during profile construction and invocation;
3. preserve listener visibility for events, recordings, transcripts, and search;
4. verify every active account receives the complete tool list;
5. update this descriptive matrix; and
6. run type checks and the web/MCP authorization suites without changing web
   access-level behavior.

## Testing

Unit tests under `web/tests/unit/mcp-*.test.ts` cover the route, authorization,
access profile, read service, tool registration, telemetry, and the stored
access-token registry. They mock Prisma and the read services, so they prove
wiring and serialization rather than database behavior.

The end-to-end contract is exercised by the isolated Docker smoke suite:

```bash
just mcp-smoke
```

It runs the MCP server against the disposable test database and mock OAuth
provider, never production. The test signs in as the seeded catalog owner
through the mock OAuth UI, accepts the MCP consent screen, exchanges an
authorization code with PKCE, validates the audience-bound JWT, exercises
stored-token issue and revocation, sends MCP 2026-07-28 `tools/list`, and calls
all ten tools. It verifies default-catalog resolution, uniform MCP tool
availability, listener-scoped metadata reads, complete transcript retrieval,
and a grounded RAG result from a deterministic test-only ColBERT mock.
Catalog-scoped calls do not supply `catalogId`, so the same run covers default
selection. The test keeps its own `test-mcp-*` Compose project and volume, then
removes both on exit. It resolves the test env file itself; inherited production
`APP_ENV`, config, and Compose project values are not used. Docker assigns
run-specific loopback ports, so an existing test stack and concurrent smoke runs
do not conflict. On a new machine, install the Playwright browser once with
`cd web && npx playwright install chromium`.

Run the smoke suite before merging any change to the tool contract, the
authorization path, or the transcript read path. It is the only test that
reaches the real stack, and it has caught contract regressions that the unit
suites passed.
