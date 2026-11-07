# Besedy MCP Tool Reference

> Last updated: 2026-11-07

This is the human-readable reference for the ten Besedy MCP tools. The
authoritative contract is the code: input schemas live in each registrar under
`web/src/lib/mcp/tools/`, success shapes in
`web/src/lib/mcp/tools/output-schemas.ts`, and both are advertised live through
`tools/list`. When this page and the code disagree, the code wins; update this
page in the same change.

For authentication, the access matrix, archive binding, telemetry, and the
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
verify important candidates with `get_transcript` by widening the returned time
window, treat the other recordings of one event as parallel captures of the
same session rather than independent evidence, group search results directly by
their returned event IDs, support recurring themes with distinct events, and cite
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
| `who_am_i`                 | Inspect the account, OAuth client, scopes, and archive access   | Active portal user                         |
| `list_locations`           | Discover location IDs used by listener-visible events            | Archive membership                         |
| `list_recorders`           | Discover recorder IDs used by listener-visible recordings        | Archive membership                         |
| `list_events`              | Page and filter released events                                  | Archive membership                         |
| `get_event`                | Read one released event and its visible recordings               | Archive membership and listener visibility |
| `get_recording`            | Read one published, ready recording linked to a released event   | Archive membership and listener visibility |
| `get_transcript`           | Read its transcript when linked to a released event              | Archive membership and listener visibility |
| `search_transcripts`       | Find event-scoped passages by meaning, including different words | Archive membership and listener visibility |
| `find_transcript_mentions` | Exhaustively find event-scoped indexed wording                   | Archive membership and listener visibility |
| `list_bookmarks`           | List the user's own bookmarks and their comments                 | `besedy:bookmarks` scope, archive membership, and listener visibility |

All tools except `list_bookmarks` are discoverable by an active portal user;
`list_bookmarks` is listed only to a client granted the `besedy:bookmarks`
scope. Discovery is only a
usability surface: every content call checks live access to the bound archive and applies listener
visibility again.

All content tools use the deployment's explicit archive binding. They do not
accept `catalogId`, and there is no `list_catalogs` tool or default-selection
chain. Input objects reject unknown fields, including retired catalog-selection
arguments. Clients must refresh their tool schemas after this change.

Result `catalogId` values, source URLs and opaque cursors retain the existing
pipeline source identity for provenance. Callable transcript requests and
continuations omit that field and can be passed directly to `get_transcript`.
Cursors from a different archive remain invalid.

## `who_am_i`

Use this tool to confirm which account and OAuth application a client is using,
especially when diagnosing missing archive access or a missing tool. It takes
no arguments.

The response has two objects:

- `account` always contains the stable account `id`. `name` requires the
  `profile` OAuth scope and `email` requires the `email` scope. A field hidden by
  scope is returned as `null`.
- `authorization` contains `clientId`, `clientName`, the effective
  `grantedScopes`, and `archive` (`id` and nullable `label`, or `null` without access).

This tool reports authorization state; it does not grant access or change the
archive binding.

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
    "archive": { "id": "20990101_000000", "label": "Besedy" }
  }
}
```

## `list_locations`

Use this tool to resolve a location name to the stable ID accepted by
`list_events.locationId` and the search tools' `filters.locationIds`. Results
contain only locations used by visible events.

| Argument    | Type                                     | Default           | Meaning                                                          |
| ----------- | ---------------------------------------- | ----------------- | ---------------------------------------------------------------- |
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
| `audioHash`     | 64-character hexadecimal string | required                | Stable recording identifier                                                |
| `startSec`      | number at least 0               | start of transcript     | Inclusive start of the time window                                         |
| `endSec`        | positive number                 | end of transcript       | Exclusive end of the time window; must exceed `startSec` when both are set |
| `mode`          | `full` or `page`                | required                | Return every matching segment or a bounded page                            |
| `segmentOffset` | non-negative integer            | `0` in `page` mode      | Page mode only: offset within segments overlapping the time window         |
| `segmentLimit`  | integer from 1 to 200           | `50` in `page` mode     | Page mode only: maximum whole segments                                     |
| `maxTextChars`  | integer from 1,000 to 50,000    | `20,000` in `page` mode | Page mode only: soft text-size target                                      |

The server reads the transcript that search indexes: the corrected transcript
once one has been published for search, and otherwise its configured canonical
transcript, the one selected by `RAG_BACKEND_KEY`. It returns
`transcript_not_found` when that transcript is absent. Transcript
implementation identifiers are not part of the MCP contract.

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
When more page-mode data exists, `continuation` preserves the recording, mode, window, limits, and next offset and can be passed
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
released events authorized by the bound archive and filters. Its
`totalMatches` is the number of matching indexed chunks before `limit` and
`maxPerRecording` reduce the returned list; it is not a count of distinct events.
Numeric text-match scores are not exposed.

It has the same `limit`, `contextChunks`, `maxPerRecording`, and
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
`get_transcript` to verify important matches, widening the request's time window
because the unchanged request only replays the matched passage. A zero result
establishes only that the chosen literal token pattern is absent under the
archive, authorization scope, filters, and match mode; it does not
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
| `query`           | non-empty string, at most 1,000 characters | required          | Natural-language question or description of the meaning to find           |
| `limit`           | integer from 1 to 200                      | `50`              | Maximum matches; smaller limits are for orientation or focused follow-ups |
| `contextChunks`   | integer from 0 to 3                        | `1`               | Adjacent indexed chunks returned before and after a match                 |
| `maxPerRecording` | integer from 1 to 100                      | `10`              | Maximum matches from one audio hash                                       |
| `filters`         | object                                     | omitted           | Optional metadata constraints described below                             |

`filters` is a strict object containing at least one of:

- `eventIds`: 1 to 50 positive event IDs returned by `list_events`;
- `audioHashes`: 1 to 50 stable 64-character audio hashes;
- `locationIds` or `recorderIds`: 1 to 50 positive integer IDs;
- `dateYears`: 1 to 50 years from 1900 through 2100;
- `verified`: a boolean; or
- `includeSecondaryRecordings`: a boolean.

Searches cover only each event's primary recording. The other recordings of an
event are parallel captures of the same session from another device, so they
would only return the same passages a second time. `includeSecondaryRecordings:
true` searches every eligible recording of every event. Naming recordings in
`audioHashes` already searches exactly those recordings, whether or not they are
primary. Recordings without an event stay searchable for grants that can see
them.

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
- `transcriptRequest`, when `get_transcript` has a transcript to read (see
  above), with `mode: "page"` and the time range to verify. This may be `null`.

The match `webUrl` is a bounded excerpt link: it seeks to `startSec`, stops once
at `endSec`, and then permits ordinary continued playback when the user presses
play again. Use the returned event `webUrl` for unbounded event context.

The generated request can be passed directly to `get_transcript`:

```json
{
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
   them directly by the returned event ID; the other recordings of the same
   event are parallel captures, not independent evidence.
4. If needed, run a smaller follow-up restricted with `filters.eventIds` or
   `filters.audioHashes`.
5. When the chosen result has a non-null `transcriptRequest`, copy it, widen its
   `startSec` and `endSec`, and only then pass the modified request to
   `get_transcript`. Unchanged values return exactly the segments the search
   already showed, so the surrounding context is what verifies the passage. Do
   not use a candidate with a null request as important evidence unless another
   source can be verified.

Run broad reformulations sequentially, compacting and deduplicating each
structured response before requesting the next one. Use the maximum of `200`
when the question requires wider coverage rather than lowering the limit merely
to shorten tool output. Meaning-based retrieval remains non-exhaustive even at
the maximum.
`search_not_configured` means the archive has no search bundle and is
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
        "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "mode": "page",
        "startSec": 580,
        "endSec": 640
      }
    }
  ]
}
```

## `list_bookmarks`

Use this tool to see which moments the user bookmarked and what they wrote
about them, for example to start from what they found worth returning to or to
find a passage they remember noting. The tool is registered only for a client
granted the `besedy:bookmarks` OAuth scope; other clients do not see it in
`tools/list`.

| Argument    | Type                                     | Default           | Meaning                                                            |
| ----------- | ---------------------------------------- | ----------------- | ------------------------------------------------------------------ |
| `query`     | non-empty string, at most 200 characters | omitted           | Case-insensitive substring match against the comment and excerpt   |
| `audioHash` | 64-character hexadecimal string          | omitted           | Only list bookmarks in this recording                              |
| `cursor`    | opaque string                            | omitted           | Continuation token returned as `nextCursor` by the previous page   |
| `limit`     | integer from 1 to 100                    | `50`              | Maximum bookmarks in the page                                      |

Only the caller's own bookmarks are returned, newest first. A bookmark appears
only while its recording passes the same listener visibility as
`get_recording`, so a bookmark made in the web application on a recording that
is unreleased, unpublished, or no longer linked to a released event stays
hidden and comes back with the access.

Each bookmark carries its `positionSec`, the user's `comment`, the transcript
`excerpt` saved when it was made, and `createdAt`/`updatedAt`. `webUrl` opens
the recording at the bookmarked position. `recording` names the recording, and
`event` is its visible event (the primary link first) or `null`.
`transcriptRequest` covers 60 seconds on each side of the position and is
`null` when `get_transcript` has no transcript to read for the recording.

The comment is the user's own note, not recording evidence: agents should treat
it as the user's interest or opinion and never cite it as what was said. The
excerpt is a snapshot that later transcript corrections do not update, so read
the passage through `transcriptRequest` before relying on its wording.

Pass `nextCursor` unchanged with the same `query` and `audioHash`.
The cursor is the creation time and ID of the last returned bookmark, so a
bookmark deleted between pages cannot invalidate it. A malformed or mismatched
cursor returns `invalid_cursor`.

Example return value:

```json
{
  "catalogId": "20990101_000000",
  "bookmarks": [
    {
      "id": "cmbookmark0000000000000",
      "positionSec": 754.2,
      "comment": "Good summary of the funding question",
      "excerpt": "The second part of the budget goes to the library.",
      "createdAt": "2099-04-13T08:15:00.000Z",
      "updatedAt": "2099-04-13T08:20:00.000Z",
      "webUrl": "https://besedy.example/catalog/20990101_000000/recording/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?seek=754.2",
      "recording": {
        "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "title": "Example recording",
        "webUrl": "https://besedy.example/catalog/20990101_000000/recording/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "event": {
        "id": 4242,
        "webUrl": "https://besedy.example/catalog/20990101_000000/event/4242",
        "date": { "year": 2099, "month": 4, "day": 12 },
        "location": { "id": 999, "name": "Example Hall" },
        "isPrimary": true
      },
      "transcriptRequest": {
        "audioHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "mode": "page",
        "startSec": 694.2,
        "endSec": 814.2
      }
    }
  ],
  "nextCursor": null
}
```

## Tool errors

Expected tool failures set `isError: true` and return the same object in
`structuredContent` and as JSON text in `content`:

```json
{
  "error": {
    "code": "not_found",
    "message": "Archive not found or inaccessible",
    "retryable": false
  }
}
```

| Code                    | Meaning                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `invalid_cursor`        | A list cursor is malformed, stale, or does not match the current request           |
| `not_found`             | The archive, event, or recording is absent or deliberately hidden by access policy |
| `identity_unavailable`  | The authenticated account disappeared before identity serialization                |
| `transcript_not_found`  | The recording has no readable transcript                                           |
| `invalid_window`        | `endSec` is not greater than `startSec`                                            |
| `response_too_large`    | A full transcript window exceeds the hard response ceiling                         |
| `search_not_configured` | The archive has no transcript search bundle                                        |
| `search_unavailable`    | The transcript search service is temporarily unavailable                           |
| `internal_error`        | An unexpected server failure was logged without exposing its details               |

Clients may automatically retry only when `retryable` is `true`; currently
that applies to `search_unavailable` and unexpected `internal_error` failures. Schema-validation and protocol
errors are produced by the MCP SDK before a tool handler runs and therefore do
not use this application error shape.
