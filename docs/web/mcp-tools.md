# Besedy MCP Tool Reference

> Last updated: 2026-09-02

This is the human-readable reference for the ten Besedy MCP tools. The
authoritative contract is the code: input schemas live in each registrar under
`web/src/lib/mcp/tools/`, success shapes in
`web/src/lib/mcp/tools/output-schemas.ts`, and both are advertised live through
`tools/list`. When this page and the code disagree, the code wins; update this
page in the same change.

For authentication, the access matrix, catalog resolution, telemetry, and the
architectural rules behind these tools, see [mcp-server.md](mcp-server.md).

## Conventions

All ten tools are read-only, idempotent, and limited to Besedy data rather
than the open web. Successful calls return machine-readable JSON in
`structuredContent`. Every tool advertises an `outputSchema` through
`tools/list`, so an agent can understand the success response before its first
call and the server can validate the returned structure. Metadata tools render
short actionable lines in `content` without duplicating their full JSON.
Transcript and search calls render evidence text there too, so clients that do
not consume structured results can still use every tool. Responses may contain
stable Besedy IDs and authenticated web links, but never audio URLs or
filesystem paths.

The MCP interface is self-contained and does not require the optional Besedy
skill. Each tool description explains when to use that tool, its scope, limits,
evidence handoff, and result semantics. Search responses repeat the essential
coverage caveats and render each candidate's non-null `transcriptRequest`, or an
explicit warning when no compatible stored transcript is available, so clients
that ignore `structuredContent` can still make a correct verification decision.

The initialization response adds only cross-tool and corpus-wide rules: ground
Besedy claims in returned evidence, distinguish meaning from literal wording,
verify important candidates with `get_transcript`, do not count recording variants
of one event as independent evidence, group search results directly by their
returned event IDs, support recurring themes with distinct events, and cite
bounded segment links. Tool descriptions and schemas remain authoritative for
individual calls and their current limits.

Tool results expose only what the documented agent workflow needs. Fields that
are empty for every production record, duplicate a neighbouring field, or carry
internal bookkeeping such as web roles, curation flags, or index chunk
identifiers are deliberately absent. Adding a field back is cheap once an
observed agent behavior needs it.

Collection tools remain paginated. Transcript reads deliberately
support either bounded page mode or an explicit full mode for callers that need
every matching segment in one response.

| Tool                       | Use it to                                                        | Required data access                       |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| `who_am_i`                 | Inspect the account, OAuth client, scopes, and default catalog   | Active portal user                         |
| `list_catalogs`            | Discover accessible catalogs and the effective default           | Active portal user                         |
| `list_locations`           | Discover location IDs used by listener-visible events            | Accessible catalog                         |
| `list_recorders`           | Discover recorder IDs used by listener-visible recordings        | Accessible catalog                         |
| `list_events`              | Page and filter released events                                  | Accessible catalog                         |
| `get_event`                | Read one released event and its visible recordings               | Accessible catalog and listener visibility |
| `get_recording`            | Read one published, ready recording linked to a released event   | Accessible catalog and listener visibility |
| `get_transcript`           | Read its transcript when linked to a released event              | Accessible catalog and listener visibility |
| `search_transcripts`       | Find event-scoped passages by meaning, including different words | Accessible catalog and listener visibility |
| `find_transcript_mentions` | Exhaustively find event-scoped indexed wording                   | Accessible catalog and listener visibility |

All tools are discoverable by an active portal user. Discovery is only a
usability surface: every catalog-scoped call authorizes its resolved catalog and
applies listener visibility again.

## `who_am_i`

Use this tool to confirm which account and OAuth application a client is using,
especially when diagnosing an unexpected catalog list or missing tool. It takes
no arguments.

The response has two objects:

- `account` always contains the stable account `id`. `name` requires the
  `profile` OAuth scope and `email` requires the `email` scope. A field hidden by
  scope is returned as `null`.
- `authorization` contains `clientId`, `clientName`, the effective
  `grantedScopes`, and `defaultCatalogId`.

This tool reports authorization state; it does not grant access or change the
active catalog.

Example return value:

```json
{
  "account": {
    "id": "user_01HZX7M4N5P6Q7R8S9T0",
    "name": "Example Listener",
    "email": "listener@example.test"
  },
  "authorization": {
    "clientId": "client_example",
    "clientName": "Example MCP client",
    "grantedScopes": ["openid", "profile", "email", "besedy:read"],
    "defaultCatalogId": "20990101_000000"
  }
}
```

## `list_catalogs`

Use this as the entry point when the catalog is unknown or when a later tool
returns a catalog-related not-found error.

| Argument | Type                  | Default | Meaning                                       |
| -------- | --------------------- | ------- | --------------------------------------------- |
| `cursor` | string                | omitted | ID of the last catalog from the previous page |
| `limit`  | integer from 1 to 100 | `50`    | Maximum catalogs in the page                  |

Each item in `catalogs` contains `id`, `label`, and `isDefault`, which marks
the effective default.
The top-level `defaultCatalogId` is the catalog selected when a catalog-scoped
tool omits `catalogId`; `defaultCatalogSource` is `user_preference`,
`global_default`, `most_recent`, or `null`.

Pass `nextCursor` unchanged to fetch the next page. `nextCursor: null` means the
list is complete. A malformed, stale, or request-mismatched cursor returns
`invalid_cursor`.

Example return value:

```json
{
  "catalogs": [
    {
      "id": "20990101_000000",
      "label": "Example catalog",
      "isDefault": true
    }
  ],
  "defaultCatalogId": "20990101_000000",
  "defaultCatalogSource": "user_preference",
  "nextCursor": null
}
```

## `list_locations`

Use this tool to resolve a location name to the stable ID accepted by
`list_events.locationId` and the search tools' `filters.locationIds`. Results
contain only locations used by visible events.

| Argument    | Type                                     | Default           | Meaning                                                          |
| ----------- | ---------------------------------------- | ----------------- | ---------------------------------------------------------------- |
| `catalogId` | string                                   | effective default | Catalog whose visible location usage is counted                  |
| `query`     | non-empty string, at most 200 characters | omitted           | Case-insensitive substring match against the location name       |
| `cursor`    | opaque string                            | omitted           | Continuation token returned as `nextCursor` by the previous page |
| `limit`     | integer from 1 to 100                    | `50`              | Maximum locations in the page                                    |

Locations are ordered by name and ID. `eventCount` counts visible events whose
authoritative event location matches.

Example return value:

```json
{
  "catalogId": "20990101_000000",
  "locations": [
    {
      "id": 999,
      "name": "Example Hall",
      "eventCount": 12
    }
  ],
  "nextCursor": null
}
```

Pass `nextCursor` unchanged with the same catalog and query to continue. The
cursor is a sort boundary, not a reference to a specific item: the next page is
every item that sorts after the last returned name and ID in the current list.
An item renamed between pages is never skipped, though it can appear again when
its new name sorts after the boundary. A malformed or mismatched cursor returns
`invalid_cursor`.

## `list_recorders`

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

Pass `nextCursor` unchanged with the same catalog and query to continue. The
cursor is a sort boundary, not a reference to a specific item: the next page is
every item that sorts after the last returned name and ID in the current list.
An item renamed between pages is never skipped, though it can appear again when
its new name sorts after the boundary. A malformed or mismatched cursor returns
`invalid_cursor`.

## `list_events`

Use this tool to browse events or resolve an event ID before calling
`get_event`. Call `list_locations` first when an exact location ID is needed.

| Argument     | Type                                     | Default           | Meaning                                                                |
| ------------ | ---------------------------------------- | ----------------- | ---------------------------------------------------------------------- |
| `catalogId`  | string                                   | effective default | Catalog to read                                                        |
| `cursor`     | opaque string                            | omitted           | Continuation token returned as `nextCursor` by the previous page       |
| `limit`      | integer from 1 to 100                    | `25`              | Maximum events in the page                                             |
| `order`      | `asc` or `desc`                          | `desc`            | Chronological date order; ascending returns oldest events first        |
| `query`      | non-empty string, at most 200 characters | omitted           | Case-insensitive literal match against title, description, or location |
| `date`       | partial date object                      | omitted           | Event date prefix: required `year`, optional `month`, optional `day`   |
| `locationId` | positive integer                         | omitted           | Exact event location ID                                                |

`date` accepts `{ year }`, `{ year, month }`, or `{ year, month, day }`; each
form matches that exact date prefix. A day without a month is invalid. Use
`locationId` for exact location matching or `query` when only the location name
is known.

Events are ordered by event year, month, day, session index, and ID in the
selected direction. Missing month or day values sort after known values. Every
item uses the common event reference shape: `id`, authenticated `webUrl`,
authoritative `date`, and authoritative `location`. Use `get_event` for event
details and attached recording hashes.

Example return value:

```json
{
  "catalogId": "20990101_000000",
  "events": [
    {
      "id": 4242,
      "webUrl": "https://besedy.example/catalog/20990101_000000/event/4242",
      "date": { "year": 2099, "month": 4, "day": 12 },
      "location": { "id": 999, "name": "Example Hall" }
    }
  ],
  "nextCursor": null
}
```

Pass `nextCursor` unchanged with the same catalog, order, and filters to
continue; `null` marks the final page. A malformed cursor, or one used with a
different catalog or order, returns `invalid_cursor`.

## `get_event`

Use this tool after `list_events` when the full event metadata or attached
recordings are needed.

| Argument          | Type                  | Default           | Meaning                                 |
| ----------------- | --------------------- | ----------------- | --------------------------------------- |
| `catalogId`       | string                | effective default | Catalog containing the event            |
| `eventId`         | positive integer      | required          | Stable event ID                         |
| `recordingOffset` | non-negative integer  | `0`               | Offset into visible attached recordings |
| `recordingLimit`  | integer from 1 to 100 | `25`              | Maximum recording summaries in the page |

The response contains `catalogId` and an `event` with its event reference, an
optional `title`, and a `recordings` page. Every
recording item contains only the stable `audioHash`, `isPrimary`, and its
authenticated `webUrl`. `totalVisible` counts only recordings visible to the
caller. Continue with `nextOffset` as
`recordingOffset`; `null` marks the final page.

Example return value:

```json
{
  "catalogId": "20990101_000000",
  "event": {
    "id": 4242,
    "webUrl": "https://besedy.example/catalog/20990101_000000/event/4242",
    "title": "Example Hall, 12 Apr 2099",
    "date": { "year": 2099, "month": 4, "day": 12 },
    "location": { "id": 999, "name": "Example Hall" },
    "recordings": {
      "items": [
        {
          "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "webUrl": "https://besedy.example/catalog/20990101_000000/recording/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "isPrimary": true
        }
      ],
      "totalVisible": 1,
      "nextOffset": null
    }
  }
}
```

## `get_recording`

Use this tool to inspect one recording identified by the stable SHA-256 audio
hash returned by an event, search, or transcript response.

| Argument    | Type                            | Default           | Meaning                          |
| ----------- | ------------------------------- | ----------------- | -------------------------------- |
| `catalogId` | string                          | effective default | Catalog containing the recording |
| `audioHash` | 64-character hexadecimal string | required          | Stable recording identifier      |

`recording` contains the title, album, duration, date, location, recorder, and
an authenticated `webUrl`; it deliberately omits curation flags, free-text
notes, guaranteed visibility flags, audio, and storage locations.
`event` uses the common event reference shape plus whether the recording is
primary, or is `null` when its event is not visible to the caller.
Search results already include event identity, date, and location, so call this
tool after search only when recording-specific descriptive metadata is needed.

Example return value:

```json
{
  "catalogId": "20990101_000000",
  "recording": {
    "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "title": "Example recording",
    "album": { "id": 77, "name": "Example series" },
    "durationHms": "00:12:30",
    "date": { "year": 2099, "month": 4, "day": 12 },
    "location": { "id": 999, "name": "Example Hall" },
    "recorder": { "id": 12, "name": "Example recorder" },
    "webUrl": "https://besedy.example/catalog/20990101_000000/recording/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "event": {
    "id": 4242,
    "webUrl": "https://besedy.example/catalog/20990101_000000/event/4242",
    "date": { "year": 2099, "month": 4, "day": 12 },
    "location": { "id": 999, "name": "Example Hall" },
    "isPrimary": true
  }
}
```

## `get_transcript`

Use this tool to read continuous source context, normally after
`search_transcripts` or `find_transcript_mentions` identifies a candidate
passage. Copy the candidate's `transcriptRequest` when it is available so the
catalog, recording, and relevant time window remain aligned.

| Argument        | Type                            | Default                 | Meaning                                                                    |
| --------------- | ------------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| `catalogId`     | string                          | effective default       | Catalog containing the recording                                           |
| `audioHash`     | 64-character hexadecimal string | required                | Stable recording identifier                                                |
| `startSec`      | number at least 0               | start of transcript     | Inclusive start of the time window                                         |
| `endSec`        | positive number                 | end of transcript       | Exclusive end of the time window; must exceed `startSec` when both are set |
| `mode`          | `full` or `page`                | required                | Return every matching segment or a bounded page                            |
| `segmentOffset` | non-negative integer            | `0` in `page` mode      | Page mode only: offset within segments overlapping the time window         |
| `segmentLimit`  | integer from 1 to 200           | `50` in `page` mode     | Page mode only: maximum whole segments                                     |
| `maxTextChars`  | integer from 1,000 to 50,000    | `20,000` in `page` mode | Page mode only: soft text-size target                                      |

The server reads only its configured canonical transcript, the one selected by
`RAG_BACKEND_KEY`. It looks in that key's transcript directory first and then in
the legacy unsuffixed directory that Czech runs and older bundles use when the
key carries a `@lang-…` suffix. It never falls back to another transcript
backend when the canonical one is absent, and returns `transcript_not_found`
instead. Transcript implementation identifiers are not part of the MCP
contract.

`mode: "full"` returns every segment overlapping the optional time window in a
single response, up to a hard 200,000-character response ceiling. With no time
window it returns the complete stored transcript only when it fits that ceiling;
otherwise use page mode or a narrower window. Pagination arguments are invalid
in full mode. `mode: "page"` retains bounded reading and continuation behavior.

The time window is half-open, but whole segments are preserved: a segment is
included when it overlaps the window. In page mode, one unusually large
segment may exceed `maxTextChars`. Segment items include their absolute
`segmentIndex`, text, timestamps, and a timestamped `webUrl`.

The response reports the unbounded `recordingWebUrl`.
Each segment link includes both `seek` and `end` timestamps.
The player stops once at the linked end; pressing play again continues through
the recording. The `segments` object contains the items and `totalMatching`.
When more page-mode data exists, `continuation` preserves the catalog,
recording, mode, window, limits, and next offset and can be passed
unchanged as the next call's arguments. Otherwise it is `null`.

The result intentionally carries no recording duration; `get_recording` reports
`durationHms`. Add it here only if usage telemetry shows agents fetching it
separately after transcript reads.

Example full-mode return value:

```json
{
  "catalogId": "20990101_000000",
  "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "recordingWebUrl": "https://besedy.example/catalog/20990101_000000/recording/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "segments": {
    "items": [
      {
        "segmentIndex": 0,
        "text": "Example transcript segment.",
        "startSec": 0,
        "endSec": 12.5,
        "webUrl": "https://besedy.example/catalog/20990101_000000/recording/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?seek=0&end=12.5"
      }
    ],
    "totalMatching": 1
  },
  "continuation": null
}
```

Page mode has the same top-level shape and may return a continuation descriptor:

```json
{
  "segments": {
    "totalMatching": 2,
    "items": [
      {
        "segmentIndex": 0,
        "text": "Example transcript segment.",
        "startSec": 0,
        "endSec": 12.5,
        "webUrl": "https://besedy.example/catalog/20990101_000000/recording/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?seek=0&end=12.5"
      }
    ]
  },
  "continuation": {
    "catalogId": "20990101_000000",
    "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "mode": "page",
    "segmentOffset": 1,
    "segmentLimit": 1,
    "maxTextChars": 20000
  }
}
```

## `find_transcript_mentions`

Use this tool for literal words, proper names, quotations, fixed phrases, and
prefixes. It searches every indexed chunk belonging to visible recordings under
released events authorized by the resolved catalog and filters. Its
`totalMatches` is the number of matching indexed chunks before `limit` and
`maxPerRecording` reduce the returned list; it is not a count of distinct events.
Numeric text-match scores are not exposed.

It has the same `catalogId`, `limit`, `contextChunks`, `maxPerRecording`, and
`filters` contract as `search_transcripts`, plus `matchMode`:

| Mode        | Meaning                                                    |
| ----------- | ---------------------------------------------------------- |
| `all_terms` | Every query token must occur in the chunk; this is default |
| `phrase`    | Tokens must be adjacent and in the given order             |
| `any_term`  | At least one query token must occur                        |
| `prefix`    | Every query token is matched as a token prefix             |

The server tokenizes the query and constructs the FTS expression itself. Raw
SQLite `MATCH` operators are therefore treated as ordinary query tokens rather
than executable query syntax. Matching is Unicode-aware and accent-insensitive,
but the current tokenizer does not perform stemming or lemmatization. Queries
are capped at 32 tokens, and `prefix` mode requires at least two characters per
token.

The tool returns the same event, recording identity, match, context, and
`transcriptRequest` result shape as meaning-based search, and a `retrieval`
object with the applied `matchMode` and the complete `totalMatches`. Use
`get_transcript` to verify important matches in continuous context. A zero result
establishes only that the chosen literal token pattern is absent under the
chosen catalog, authorization scope, filters, and match mode; it does not
establish conceptual absence. Rendered text repeats that scope, distinguishes
the complete indexed `totalMatches` count from capped returned passages, and
includes event date and location plus each non-null `transcriptRequest` for
clients that do not consume `structuredContent`. When the request is null,
rendered text says that the candidate cannot be used as important evidence
without another verified source.

## `search_transcripts`

Use this tool to find passages by meaning: questions, themes, related concepts,
paraphrases, and different wording. It can find relevant passages even when the
exact query words are absent. Do not use it as proof that the corpus does or
does not contain something. Retrieval is non-exhaustive by design, as the tool
description states, and results are ordered by relevance through `rank`;
internal numeric retrieval scores are not exposed.

| Argument          | Type                                       | Default           | Meaning                                                                   |
| ----------------- | ------------------------------------------ | ----------------- | ------------------------------------------------------------------------- |
| `catalogId`       | string                                     | effective default | Catalog to search                                                         |
| `query`           | non-empty string, at most 1,000 characters | required          | Natural-language question or description of the meaning to find           |
| `limit`           | integer from 1 to 200                      | `50`              | Maximum matches; smaller limits are for orientation or focused follow-ups |
| `contextChunks`   | integer from 0 to 3                        | `1`               | Adjacent indexed chunks returned before and after a match                 |
| `maxPerRecording` | integer from 1 to 100                      | `10`              | Maximum matches from one audio hash                                       |
| `filters`         | object                                     | omitted           | Optional metadata constraints described below                             |

`filters` is a strict object containing at least one of:

- `eventIds`: 1 to 50 positive event IDs returned by `list_events`;
- `audioHashes`: 1 to 50 stable 64-character audio hashes;
- `locationIds` or `recorderIds`: 1 to 50 positive integer IDs;
- `dateYears`: 1 to 50 years from 1900 through 2100; or
- `verified`: a boolean.

`eventIds` restricts matches to recordings linked to any selected event. This
supports a direct `list_events` to either search tool workflow without making
the caller expand each event into recording hashes. `locationIds` and
`dateYears` refer to authoritative event metadata. `recorderIds` and `verified`
remain optional curated-recording constraints; they are filters only and are not
returned as search-result context. A hidden or unknown value in `eventIds` or
`audioHashes` fails the whole call with `not_found`.

A low `maxPerRecording`, such as `1`, increases diversity across recordings and
is useful for initial orientation. A precise broad search should keep the
default or raise it when distinct passages from one recording may matter. The
default remains `10` so one long recording does not dominate broad discovery,
while values up to `100` support deep recording-focused searches. The overall
`limit` still bounds the number of returned matches.
Adjacent chunks are mechanical context for triage: they may not contain a
complete question, answer, qualification, or discussion arc.

Rendered text labels the candidates as ranked and non-exhaustive, warns that an
empty result does not establish conceptual absence, and leads each candidate
with its event date and location. It includes the event ID, event URL, recording
hash, and each non-null `transcriptRequest` so a client can group evidence and
verify it without consuming `structuredContent`. A null request instead produces
an explicit unavailable-verification warning.

Every result contains:

- the authoritative `event` ID, authenticated event `webUrl`, date, and
  location;
- a minimal `recording` identity containing only the stable `audioHash`;
- the exact `match`, including time range, text, and seekable `webUrl`, which
  is the citation;
- optional before/after `context` without duplicating the exact match; and
- `transcriptRequest`, when the canonical transcript exists, with
  `mode: "page"` and the time range to verify. This may be `null`.

The match `webUrl` is a bounded excerpt link: it seeks to `startSec`, stops once
at `endSec`, and then permits ordinary continued playback when the user presses
play again. Use the returned event `webUrl` for unbounded event context.

The generated request can be passed directly to `get_transcript`:

```json
{
  "catalogId": "20990101_000000",
  "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "mode": "page",
  "startSec": 600,
  "endSec": 720
}
```

The recommended evidence workflow is:

1. Run a small orientation search with a low `maxPerRecording` to learn the
   corpus vocabulary and identify promising sources.
2. Before synthesizing, run precise broad searches with the 50-result default,
   several materially different reformulations, and multiple matches per
   recording when useful. Do not wait for the user to request more precision.
3. Shortlist results from their exact match, adjacent context, and event. Group
   them directly by the returned event ID; recordings sharing an event are
   variants, not independent evidence.
4. If needed, run a smaller follow-up restricted with `filters.eventIds` or
   `filters.audioHashes`.
5. When the chosen result has a non-null `transcriptRequest`, pass it to
   `get_transcript` and read the continuous source context before relying on the
   passage. Do not use a candidate with a null request as important evidence
   unless another source can be verified.

Run broad reformulations sequentially, compacting and deduplicating each
structured response before requesting the next one. Use the maximum of `200`
when the question requires wider coverage rather than lowering the limit merely
to shorten tool output. Meaning-based retrieval remains non-exhaustive even at
the maximum.
`search_not_configured` means the catalog has no search bundle and is
not retryable. `search_unavailable` means the search service is temporarily
unavailable and is retryable.

Example return value:

```json
{
  "catalogId": "20990101_000000",
  "query": "example topic",
  "results": [
    {
      "rank": 1,
      "event": {
        "id": 4242,
        "webUrl": "https://besedy.example/catalog/20990101_000000/event/4242",
        "date": { "year": 2099, "month": 4, "day": 12 },
        "location": { "id": 999, "name": "Example Hall" }
      },
      "recording": {
        "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "match": {
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
      "transcriptRequest": {
        "catalogId": "20990101_000000",
        "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "mode": "page",
        "startSec": 580,
        "endSec": 640
      }
    }
  ]
}
```

## Tool errors

Expected tool failures set `isError: true` and return the same object in
`structuredContent` and as JSON text in `content`:

```json
{
  "error": {
    "code": "not_found",
    "message": "Catalog not found or inaccessible",
    "retryable": false
  }
}
```

| Code                    | Meaning                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `catalog_required`      | No effective default exists; supply `catalogId`                                    |
| `invalid_cursor`        | A list cursor is malformed, stale, or does not match the current request           |
| `not_found`             | The catalog, event, or recording is absent or deliberately hidden by access policy |
| `identity_unavailable`  | The authenticated account disappeared before identity serialization                |
| `transcript_not_found`  | The recording has no readable canonical transcript                                 |
| `invalid_window`        | `endSec` is not greater than `startSec`                                            |
| `response_too_large`    | A full transcript window exceeds the hard response ceiling                         |
| `search_not_configured` | The catalog has no transcript search bundle                                        |
| `search_unavailable`    | The transcript search service is temporarily unavailable                           |
| `internal_error`        | An unexpected server failure was logged without exposing its details               |

Clients may automatically retry only when `retryable` is `true`; currently
that applies to `search_unavailable` and unexpected `internal_error` failures. Schema-validation and protocol
errors are produced by the MCP SDK before a tool handler runs and therefore do
not use this application error shape.
