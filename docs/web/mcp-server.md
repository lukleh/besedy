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
all nine tools. It verifies default-catalog resolution, the owner's live
capability flags, metadata reads, complete transcript retrieval, and a grounded
RAG result from a deterministic test-only ColBERT mock. Catalog-scoped calls do
not supply `catalogId`, so the same run covers default selection. The test keeps
its own `test-mcp-*` Compose project and volume, then removes both on exit. It
resolves the test env file itself; inherited production `APP_ENV`, config, and
Compose project values are not used. Docker assigns run-specific loopback ports,
so an existing test stack and concurrent smoke runs do not conflict. On a new
machine, install the Playwright browser once with
`cd web && npx playwright install chromium`.

> Last updated: 2026-08-27

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

## Reference pattern for MCP tools

`who_am_i` is the smallest reference implementation for how an MCP tool should
combine authentication, current state, shared web policy, and response
serialization:

1. **Refresh authorization for every request.** The MCP route validates the
   token subject, OAuth client, resource, current consent, and current portal
   access. For consented clients, effective scopes are the intersection of the
   token claims and live consent, so an old token cannot preserve a scope the
   user has revoked. Current portal access is required for every client.
2. **Use canonical policy state.** `getMcpAccessProfile` obtains the current
   actor, system role, catalog grants, defaults, and capabilities through the
   same policy functions used by the web application. A tool must not derive a
   role or permission again from raw database flags.
3. **Keep identity data separate from authorization.** `getMcpIdentity` loads
   only account and OAuth-client display data. `who_am_i` gets status and role
   from the access profile rather than treating identity fields as permission
   facts.
4. **Gate both tools and returned fields.** Tool discovery is personalized for
   usability, but each invocation must still authorize its resolved target.
   Response serialization must also enforce OAuth scopes: `profile` controls
   name, status, and role, while `email` controls email fields.
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
portal authorization, shared policy code decides Besedy capabilities, shared
read services retrieve only authorized domain data, and the MCP handler shapes
the agent-facing result. Tests should cover discovery, direct invocation,
scope-gated fields, a denied target, and the tool's structured failure paths.

Each tool lives in its own registrar module under
`web/src/lib/mcp/tools/`. `server.ts` only creates the server and applies the
personalized discovery gates before calling those registrars. Shared catalog
resolution and structured success/error handling live in `tools/shared.ts` so
tools cannot drift into different not-found, permission, or retry semantics.
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
- MCP access is a strict subset of Besedy access. A person whose email is not on
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
  endpoint.
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
  endpoint rate limit applies.
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

## Tool reference

All nine tools are read-only, idempotent, and limited to Besedy data rather
than the open web. Successful calls return machine-readable JSON in
`structuredContent`. Every tool advertises an `outputSchema` through
`tools/list`, so an agent can understand the success response before its first
call and the server can validate the returned structure. The `content` field
contains a concise summary plus compact JSON for metadata tools; transcript and
search calls instead render their evidence text there for clients that do not
consume structured results. Responses may contain stable Besedy IDs and
authenticated web links, but never audio URLs or filesystem paths.

The MCP initialization response also includes concise server instructions for
agents that connect without the optional Besedy skill. They describe the
cross-tool discovery and evidence workflow: semantic search is non-exhaustive,
important passages should be verified through `transcriptRequest` and
`get_transcript`, recorder variants of one event are not independent evidence,
recurring themes require support from distinct events, and bounded segment
links are preferred for citations. Tool descriptions and schemas remain
authoritative for individual calls and their current limits.

Collection tools remain paginated. Transcript reads deliberately
support either bounded page mode or an explicit full mode for callers that need
every matching segment in one response.

| Tool                 | Use it to                                                     | Required access                               |
| -------------------- | ------------------------------------------------------------- | --------------------------------------------- |
| `who_am_i`           | Inspect the account, OAuth client, scopes, and access summary | Active portal user                            |
| `list_catalogs`      | Discover accessible catalogs and per-catalog capabilities     | Active portal user                            |
| `list_locations`     | Discover location IDs used by visible events or recordings    | `canGetRecordings`                            |
| `list_recorders`     | Discover recorder IDs used by visible recordings              | `canGetRecordings`                            |
| `list_events`        | Page and filter visible events                                | `canListEvents`                               |
| `get_event`          | Read one event and its visible recording summaries            | `canListEvents` and event visibility          |
| `get_recording`      | Read one recording's metadata and linked events               | `canGetRecordings` and recording visibility   |
| `get_transcript`     | Read a bounded, continuous transcript window                  | `canViewTranscripts` and recording visibility |
| `search_transcripts` | Find candidate passages with semantic transcript search       | `canSearchTranscripts`                        |

`who_am_i` and `list_catalogs` are always discoverable by an active portal
user. The remaining tools are discoverable when the user has their required
capability in at least one catalog. Discovery is only a usability hint: every
catalog-scoped call authorizes its resolved catalog and target again.

### `who_am_i`

Use this tool to confirm which account and OAuth application a client is using,
especially when diagnosing an unexpected catalog list or missing tool. It takes
no arguments.

The response has two objects:

- `account` always contains the stable account `id`. `name`, `status`, and
  `systemRole` require the `profile` OAuth scope; `email` and `emailVerified`
  require the `email` scope. A field hidden by scope is returned as `null`.
- `authorization` contains `clientId`, `clientName`, the effective
  `grantedScopes`, `accessibleCatalogCount`, and `defaultCatalogId`.

This tool reports authorization state; it does not grant access or change the
active catalog.

Example return value:

```json
{
  "account": {
    "id": "user_01HZX7M4N5P6Q7R8S9T0",
    "name": "Example Listener",
    "email": "listener@example.test",
    "emailVerified": true,
    "status": "ACTIVE",
    "systemRole": "USER"
  },
  "authorization": {
    "clientId": "client_example",
    "clientName": "Example MCP client",
    "grantedScopes": ["openid", "profile", "email"],
    "accessibleCatalogCount": 1,
    "defaultCatalogId": "20990101_000000"
  }
}
```

### `list_catalogs`

Use this as the entry point when the catalog is unknown or when a later tool
returns a catalog-related permission error.

| Argument | Type                  | Default | Meaning                                       |
| -------- | --------------------- | ------- | --------------------------------------------- |
| `cursor` | string                | omitted | ID of the last catalog from the previous page |
| `limit`  | integer from 1 to 100 | `50`    | Maximum catalogs in the page                  |

Each item in `catalogs` contains `id`, `label`, `catalogGrant`,
`isCatalogAdmin`, and the capability flags used by the other tools. It also
distinguishes `isUserDefault`, `isGlobalDefault`, and `isEffectiveDefault`.
The top-level `defaultCatalogId` is the catalog selected when a catalog-scoped
tool omits `catalogId`; `defaultCatalogSource` is `user_preference`,
`global_default`, `most_recent`, or `null`.

Pass `nextCursor` unchanged to fetch the next page. `nextCursor: null` means the
list is complete. An unknown cursor returns `invalid_cursor`.

Example return value:

```json
{
  "catalogs": [
    {
      "id": "20990101_000000",
      "label": "Example catalog",
      "isUserDefault": true,
      "isGlobalDefault": false,
      "isEffectiveDefault": true,
      "catalogGrant": "VIEWER",
      "isCatalogAdmin": false,
      "capabilities": {
        "canListEvents": true,
        "canGetRecordings": true,
        "canViewTranscripts": true,
        "canSearchTranscripts": true,
        "canSeeUnreleasedEvents": true
      }
    }
  ],
  "defaultCatalogId": "20990101_000000",
  "defaultCatalogSource": "user_preference",
  "nextCursor": null
}
```

### `list_locations`

Use this tool to resolve a location name to the stable ID accepted by
`list_events.locationId` and `search_transcripts.filters.locationIds`. Results
contain only locations used by recordings the caller can read or, when event
browsing is enabled for the catalog, by events the caller can read.

| Argument    | Type                                     | Default           | Meaning                                                          |
| ----------- | ---------------------------------------- | ----------------- | ---------------------------------------------------------------- |
| `catalogId` | string                                   | effective default | Catalog whose visible location usage is counted                  |
| `query`     | non-empty string, at most 200 characters | omitted           | Case-insensitive substring match against the location name       |
| `cursor`    | opaque string                            | omitted           | Continuation token returned as `nextCursor` by the previous page |
| `limit`     | integer from 1 to 100                    | `50`              | Maximum locations in the page                                    |

Locations are ordered by name and ID. `recordingCount` counts readable
recordings with that curated recording location. `eventCount` counts readable
events whose event location matches; it is `null` when event browsing is not
enabled for the selected catalog. The two counts are intentionally distinct:
an event can contain recordings whose curated locations differ from the event
location.

Example return value:

```json
{
  "catalogId": "20990101_000000",
  "locations": [
    {
      "id": 999,
      "name": "Example Hall",
      "eventCount": 12,
      "recordingCount": 18
    }
  ],
  "nextCursor": null
}
```

Pass `nextCursor` unchanged with the same catalog and query to continue. A
malformed or mismatched cursor returns `invalid_cursor`.

### `list_recorders`

Use this tool to resolve a recorder name to the stable ID accepted by
`search_transcripts.filters.recorderIds`. Results contain only recorders used
by recordings the caller can read.

| Argument    | Type                                     | Default           | Meaning                                                          |
| ----------- | ---------------------------------------- | ----------------- | ---------------------------------------------------------------- |
| `catalogId` | string                                   | effective default | Catalog whose visible recorder usage is counted                  |
| `query`     | non-empty string, at most 200 characters | omitted           | Case-insensitive substring match against the recorder name       |
| `cursor`    | opaque string                            | omitted           | Continuation token returned as `nextCursor` by the previous page |
| `limit`     | integer from 1 to 100                    | `50`              | Maximum recorders in the page                                    |

Recorders are ordered by name and ID. `recordingCount` counts readable
recordings with that curated recorder.

Example return value:

```json
{
  "catalogId": "20990101_000000",
  "recorders": [
    { "id": 998, "name": "Example Recorder", "recordingCount": 27 }
  ],
  "nextCursor": null
}
```

Pass `nextCursor` unchanged with the same catalog and query to continue. A
malformed or mismatched cursor returns `invalid_cursor`.

### `list_events`

Use this tool to browse events or resolve an event ID before calling
`get_event`. Call `list_locations` first when an exact location ID is needed.

| Argument     | Type                                     | Default           | Meaning                                                                |
| ------------ | ---------------------------------------- | ----------------- | ---------------------------------------------------------------------- |
| `catalogId`  | string                                   | effective default | Catalog to read                                                        |
| `cursor`     | opaque string                            | omitted           | Continuation token returned as `nextCursor` by the previous page       |
| `limit`      | integer from 1 to 100                    | `25`              | Maximum events in the page                                             |
| `order`      | `asc` or `desc`                          | `desc`            | Chronological date order; ascending returns oldest events first        |
| `released`   | boolean                                  | omitted           | Include only released or only unreleased events                        |
| `query`      | non-empty string, at most 200 characters | omitted           | Case-insensitive literal match against title, description, or location |
| `date`       | partial date object                      | omitted           | Event date prefix: required `year`, optional `month`, optional `day`   |
| `locationId` | positive integer                         | omitted           | Exact event location ID                                                |

`date` accepts `{ year }`, `{ year, month }`, or `{ year, month, day }`; each
form matches that exact date prefix. A day without a month is invalid. Use
`locationId` for exact location matching or `query` when only the location name
is known.

Events are ordered by event year, month, day, session index, and ID in the
selected direction. Missing month or day values sort after known values. Each
event includes its metadata, release state, last-updated timestamp, authenticated `webUrl`, and a
permission-scoped `recordings` object. `recordings.audioHashes` contains every
visible attached recording hash in event sort order.
`recordings.primaryAudioHash` identifies the visible primary recording, falls
back to the first visible recording when no primary is marked, and is `null`
when no recording is visible.

Example return value:

```json
{
  "catalogId": "20990101_000000",
  "events": [
    {
      "id": 4242,
      "webUrl": "https://besedy.example/catalog/20990101_000000/event/4242",
      "title": "Example Hall, 12 Apr 2099",
      "description": "Fictional event used only for documentation",
      "date": { "year": 2099, "month": 4, "day": 12 },
      "sessionIndex": 1,
      "location": { "id": 999, "name": "Example Hall" },
      "released": true,
      "recordings": {
        "primaryAudioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "audioHashes": [
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ]
      },
      "updatedAt": "2099-04-13T08:30:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Pass `nextCursor` unchanged with the same catalog, order, and filters to
continue; `null` marks the final page. A malformed cursor, or one used with a
different catalog or order, returns `invalid_cursor`.

### `get_event`

Use this tool after `list_events` when the full event metadata or attached
recordings are needed.

| Argument          | Type                  | Default           | Meaning                                 |
| ----------------- | --------------------- | ----------------- | --------------------------------------- |
| `catalogId`       | string                | effective default | Catalog containing the event            |
| `eventId`         | positive integer      | required          | Stable event ID                         |
| `recordingOffset` | non-negative integer  | `0`               | Offset into visible attached recordings |
| `recordingLimit`  | integer from 1 to 100 | `25`              | Maximum recording summaries in the page |

The response contains `catalogId` and an `event` with full event metadata,
timestamps, authenticated `webUrl`, and a `recordings` page. Every recording
item includes the stable `audioHash`, compact metadata, `isPrimary`,
`sortOrder`, and its authenticated `webUrl`. `totalVisible` counts only
recordings visible to the caller. Continue with `nextOffset` as
`recordingOffset`; `null` marks the final page.

Example return value:

```json
{
  "catalogId": "20990101_000000",
  "event": {
    "id": 4242,
    "webUrl": "https://besedy.example/catalog/20990101_000000/event/4242",
    "title": "Example Hall, 12 Apr 2099",
    "description": "Fictional event used only for documentation",
    "date": { "year": 2099, "month": 4, "day": 12 },
    "sessionIndex": 1,
    "location": { "id": 999, "name": "Example Hall" },
    "released": true,
    "recordings": {
      "items": [
        {
          "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "title": "Example recording",
          "artist": "Example speaker",
          "durationHms": "00:12:30",
          "ready": true,
          "published": true,
          "webUrl": "https://besedy.example/catalog/20990101_000000/recording/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "isPrimary": true,
          "sortOrder": 0
        }
      ],
      "totalVisible": 1,
      "nextOffset": null
    },
    "createdAt": "2099-04-12T18:00:00.000Z",
    "updatedAt": "2099-04-13T08:30:00.000Z"
  }
}
```

### `get_recording`

Use this tool to inspect one recording identified by the stable SHA-256 audio
hash returned by an event, search, or transcript response.

| Argument      | Type                            | Default           | Meaning                           |
| ------------- | ------------------------------- | ----------------- | --------------------------------- |
| `catalogId`   | string                          | effective default | Catalog containing the recording  |
| `audioHash`   | 64-character hexadecimal string | required          | Stable recording identifier       |
| `eventOffset` | non-negative integer            | `0`               | Offset into visible linked events |
| `eventLimit`  | integer from 1 to 100           | `25`              | Maximum linked events in the page |

`recording` contains the descriptive metadata, readiness and publication
flags, and authenticated `webUrl`; it deliberately omits audio and storage
locations. The `events` page contains compact visible event summaries and
whether the recording is primary for each event. Continue with `nextOffset` as
`eventOffset`; `null` marks the final page.

Example return value:

```json
{
  "catalogId": "20990101_000000",
  "recording": {
    "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "title": "Example recording",
    "artist": "Example speaker",
    "album": { "id": 77, "name": "Example series" },
    "durationHms": "00:12:30",
    "sourceDate": "2099-04-12",
    "date": { "year": 2099, "month": 4, "day": 12 },
    "location": { "id": 999, "name": "Example Hall" },
    "recorder": { "id": 12, "name": "Example recorder" },
    "verified": true,
    "notes": "Fictional recording used only for documentation",
    "tags": ["example"],
    "ready": true,
    "published": true,
    "webUrl": "https://besedy.example/catalog/20990101_000000/recording/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "events": {
    "items": [
      {
        "id": 4242,
        "webUrl": "https://besedy.example/catalog/20990101_000000/event/4242",
        "title": "Example Hall, 12 Apr 2099",
        "released": true,
        "date": { "year": 2099, "month": 4, "day": 12 },
        "isPrimary": true
      }
    ],
    "totalVisible": 1,
    "nextOffset": null
  }
}
```

### `get_transcript`

Use this tool to read continuous source context, normally after
`search_transcripts` identifies a candidate passage. Copy the candidate's
`transcriptRequest` when it is available so the catalog, recording, backend,
and relevant time window remain aligned.

| Argument        | Type                            | Default                            | Meaning                                                                    |
| --------------- | ------------------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| `catalogId`     | string                          | effective default                  | Catalog containing the recording                                           |
| `audioHash`     | 64-character hexadecimal string | required                           | Stable recording identifier                                                |
| `backend`       | `workflow/model` string         | highest-priority available backend | Stored transcript backend to read                                          |
| `startSec`      | number at least 0               | start of transcript                | Inclusive start of the time window                                         |
| `endSec`        | positive number                 | end of transcript                  | Exclusive end of the time window; must exceed `startSec` when both are set |
| `mode`          | `full` or `page`                | required                           | Return every matching segment or a bounded page                            |
| `segmentOffset` | non-negative integer            | `0` in `page` mode                 | Page mode only: offset within segments overlapping the time window         |
| `segmentLimit`  | integer from 1 to 200           | `50` in `page` mode                | Page mode only: maximum whole segments                                     |
| `maxTextChars`  | integer from 1,000 to 50,000    | `20,000` in `page` mode            | Page mode only: soft text-size target                                      |

`mode: "full"` returns every segment overlapping the optional time window in a
single response. With no time window it returns the complete stored transcript.
Pagination arguments are invalid in full mode. `mode: "page"` retains bounded
reading and continuation behavior.

The time window is half-open, but whole segments are preserved: a segment is
included when it overlaps the window. In page mode, one unusually large
segment may exceed `maxTextChars`. Segment items include their absolute
`segmentIndex`, text, timestamps, optional speaker and source ID, and a
timestamped `webUrl`.

The response also reports the chosen `backend`, `availableBackends`, language,
duration, normalized `timeWindow`, `recordingWebUrl`, and a `seekWebUrl` for
the first returned segment. Segment and seek links include both `seek` and
`end` timestamps. The player stops once at the linked end; pressing play again
continues through the recording. An empty page has `seekWebUrl: null`. The
`segments` object reports `returnedTextChars`, `totalMatching`, and
`nextOffset`. Full mode reports `limit` and `maxTextChars` as `null` and always
returns `nextOffset: null` and `continuation: null`. When more page-mode data
exists, `continuation` preserves the catalog, recording, backend, mode, window,
limits, and next offset and can be passed unchanged as the next call's
arguments. Otherwise it is `null`.

Example full-mode return value:

```json
{
  "catalogId": "20990101_000000",
  "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "recordingWebUrl": "https://besedy.example/catalog/20990101_000000/recording/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "seekWebUrl": "https://besedy.example/catalog/20990101_000000/recording/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?seek=0&end=12.5",
  "backend": "faster-whisper/large-v3@silero_vad_v6",
  "availableBackends": [
    "faster-whisper/large-v3@silero_vad_v6",
    "whisperx/large-v3@silero"
  ],
  "language": "en",
  "durationSec": 12.5,
  "mode": "full",
  "timeWindow": { "startSec": null, "endSec": null },
  "segments": {
    "items": [
      {
        "segmentIndex": 0,
        "id": null,
        "text": "Example transcript segment.",
        "startSec": 0,
        "endSec": 12.5,
        "speaker": null,
        "webUrl": "https://besedy.example/catalog/20990101_000000/recording/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?seek=0&end=12.5"
      }
    ],
    "offset": 0,
    "limit": null,
    "maxTextChars": null,
    "returnedTextChars": 27,
    "totalMatching": 1,
    "nextOffset": null
  },
  "continuation": null
}
```

Page mode has the same top-level shape, but reports numeric page limits and may
return a continuation descriptor:

```json
{
  "mode": "page",
  "segments": {
    "offset": 0,
    "limit": 1,
    "maxTextChars": 20000,
    "returnedTextChars": 27,
    "totalMatching": 2,
    "nextOffset": 1,
    "items": [
      {
        "segmentIndex": 0,
        "id": null,
        "text": "Example transcript segment.",
        "startSec": 0,
        "endSec": 12.5,
        "speaker": null,
        "webUrl": "https://besedy.example/catalog/20990101_000000/recording/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?seek=0&end=12.5"
      }
    ]
  },
  "continuation": {
    "catalogId": "20990101_000000",
    "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "backend": "faster-whisper/large-v3@silero_vad_v6",
    "mode": "page",
    "segmentOffset": 1,
    "segmentLimit": 1,
    "maxTextChars": 20000
  }
}
```

### `search_transcripts`

Use this tool for semantic discovery, not as proof that the corpus does or does
not contain something. Retrieval is deliberately marked non-exhaustive, and
results are ordered by relevance through `rank`; internal numeric retrieval
scores are not exposed.

| Argument          | Type                                       | Default           | Meaning                                                              |
| ----------------- | ------------------------------------------ | ----------------- | -------------------------------------------------------------------- |
| `catalogId`       | string                                     | effective default | Catalog to search                                                    |
| `query`           | non-empty string, at most 1,000 characters | required          | Natural-language semantic query                                      |
| `limit`           | integer from 1 to 100                      | `100`             | Maximum matches; use a smaller explicit limit for focused follow-ups |
| `contextChunks`   | integer from 0 to 3                        | `1`               | Adjacent indexed chunks returned before and after a match            |
| `maxPerRecording` | integer from 1 to 100                      | `3`               | Maximum matches from one audio hash                                  |
| `filters`         | object                                     | omitted           | Optional metadata constraints described below                        |

`filters` is a strict object containing at least one of:

- `eventIds`: 1 to 50 positive event IDs returned by `list_events`;
- `audioHashes`: 1 to 50 stable 64-character audio hashes;
- `locationIds` or `recorderIds`: 1 to 50 positive integer IDs;
- `dateYears`: 1 to 50 years from 1900 through 2100; or
- `verified`: a boolean.

`eventIds` restricts matches to recordings linked to any selected event. This
supports a direct `list_events` to `search_transcripts` workflow without making
the caller expand each event into recording hashes. `locationIds`,
`recorderIds`, `dateYears`, and `verified` refer to curated recording metadata.

A low `maxPerRecording`, such as `1`, increases diversity across recordings. A
higher value is useful after narrowing the search to one or more recordings.
The default remains `3` so one long recording does not dominate broad
discovery, while values up to `100` support deep recording-focused searches.
The overall `limit` still bounds the number of returned matches.
Adjacent chunks are mechanical context for triage: they may not contain a
complete question, answer, qualification, or discussion arc.

Every result contains:

- a compact `recording` summary and authenticated recording `webUrl`;
- the exact `match`, including chunk ID, time range, text, and seekable
  `webUrl`;
- optional before/after `context` without duplicating the exact match;
- date, location, and recorder `metadata`;
- a stable `citation` naming the audio hash, chunk, time range, catalog, RAG
  backend, and chunk version; and
- `transcriptRequest`, when a compatible stored transcript exists, with the
  actual transcript backend, `mode: "page"`, and the time range to verify. This
  may be `null`.

The match `webUrl` is a bounded excerpt link: it seeks to `startSec`, stops
once at `endSec`, and then permits ordinary continued playback when the user
presses play again. The recording summary's `webUrl` remains unbounded.

The generated request can be passed directly to `get_transcript`:

```json
{
  "catalogId": "20990101_000000",
  "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "backend": "faster-whisper/large-v3@silero_vad_v6",
  "mode": "page",
  "startSec": 600,
  "endSec": 720
}
```

The recommended evidence workflow is:

1. Run a broad semantic search with a low `maxPerRecording`.
2. Shortlist results from their exact match and adjacent context.
3. If needed, run a smaller follow-up restricted with `filters.eventIds` or
   `filters.audioHashes`.
4. Call `get_transcript` with the chosen result's `transcriptRequest` and read
   the continuous source context before relying on the passage.

Do not repeatedly request the 100-result default for reformulations; choose an
intentional smaller `limit`. `search_not_configured` means the catalog has no
search bundle and is not retryable. `search_unavailable` means the search
service is temporarily unavailable and is retryable.

Example return value:

```json
{
  "catalogId": "20990101_000000",
  "query": "example topic",
  "retrieval": {
    "mode": "semantic",
    "exhaustive": false,
    "requestedLimit": 10,
    "returnedCount": 1,
    "maxPerRecording": 1
  },
  "results": [
    {
      "rank": 1,
      "recording": {
        "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "title": "Example recording",
        "artist": "Example speaker",
        "durationHms": "00:12:30",
        "ready": true,
        "published": true,
        "webUrl": "https://besedy.example/catalog/20990101_000000/recording/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "match": {
        "chunkId": "chunk-example-0001",
        "startSec": 600,
        "endSec": 620,
        "text": "Example matching transcript passage.",
        "webUrl": "https://besedy.example/catalog/20990101_000000/recording/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?seek=600&end=620"
      },
      "context": {
        "startSec": 580,
        "endSec": 640,
        "beforeText": "Example preceding context.",
        "afterText": "Example following context."
      },
      "metadata": {
        "date": { "year": 2099, "month": 4, "day": 12 },
        "location": { "id": 999, "name": "Example Hall" },
        "recorder": { "id": 12, "name": "Example recorder" }
      },
      "citation": {
        "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "chunkId": "chunk-example-0001",
        "startSec": 600,
        "endSec": 620,
        "workflowGroupId": "20990101_000000",
        "backendKey": "faster-whisper/large-v3@silero_vad_v6",
        "chunkVersion": "example-v1"
      },
      "transcriptRequest": {
        "catalogId": "20990101_000000",
        "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "backend": "faster-whisper/large-v3@silero_vad_v6",
        "mode": "page",
        "startSec": 580,
        "endSec": 640
      }
    }
  ]
}
```

### Tool errors

Expected tool failures set `isError: true` and return the same object in
`structuredContent` and as JSON text in `content`:

```json
{
  "error": {
    "code": "permission_denied",
    "message": "Catalog permission does not allow canViewTranscripts",
    "retryable": false
  }
}
```

| Code                    | Meaning                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `catalog_required`      | No effective default exists; supply `catalogId`                                    |
| `invalid_cursor`        | The catalog cursor is not present in the accessible catalog list                   |
| `not_found`             | The catalog, event, or recording is absent or deliberately hidden by access policy |
| `permission_denied`     | The catalog or recording is visible, but the requested capability is unavailable   |
| `identity_unavailable`  | The authenticated account disappeared before identity serialization                |
| `transcript_not_found`  | The requested recording/backend has no readable stored transcript                  |
| `invalid_window`        | `endSec` is not greater than `startSec`                                            |
| `search_not_configured` | The catalog has no transcript search bundle                                        |
| `search_unavailable`    | The transcript search service is temporarily unavailable                           |

Clients may automatically retry only when `retryable` is `true`; currently
that applies only to `search_unavailable`. Schema-validation and protocol
errors are produced by the MCP SDK before a tool handler runs and therefore do
not use this application error shape.

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
character counts. Permission denials are also mirrored into `audit_log` as
security events with `resource = 'mcp'`. A telemetry-write failure is logged but
must not change the MCP tool result.

## Change checklist for permissions

Any access-level change is incomplete until all of these are true:

1. change the canonical policy function;
2. update its matrix/table-driven tests;
3. verify the web API/UI consumes the resulting capability;
4. verify MCP discovery and invocation consume the same capability;
5. update this descriptive matrix; and
6. run type checks and the web/MCP authorization suites.
