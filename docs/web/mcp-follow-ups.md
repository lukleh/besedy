# Besedy MCP Follow-ups

> Last updated: 2026-09-02

Deferred items from the MCP review that landed as PR #90. None of these blocks
deployment. Each entry records what was found, why it was left, and what would
make it worth doing. Remove an entry when it ships or when the reason to defer
becomes permanent.

## Test coverage

**Smoke suite covers one happy path.** `just mcp-smoke` signs in as the catalog
owner and walks every tool once. Nothing end-to-end exercises a listener-only
account, a hidden or unreleased event, a recording linked only to a hidden
event, or an account with no catalog grants. The access matrix in
[mcp-server.md](mcp-server.md) is therefore documented but not enforced by a
test that reaches the database. Add a second smoke test per role and per hidden
target; the seed data already contains an unreleased event and a listener user.

**Unit tests use `toMatchObject` on several tool outputs.** The MCP SDK
validates `structuredContent` against the zod output schema but forwards the
original object unstripped, so an extra field would reach agents without any
test failing. `get_recording`, `get_event`, and `who_am_i` unit tests should
assert exact key sets, as the e2e now does for search results.

**Retention and migration tests are string matches.** The tests for
`mcp-usage-retention.sh` and the consent-revocation triggers assert substrings
of SQL and never execute it. One integration test against the disposable test
database would make them meaningful.

## Authorization

**Refresh-token serialization is more machinery than benefit.** A second
PostgreSQL pool holds session-level advisory locks around Better Auth's refresh
grant, and three PL/pgSQL triggers maintain their own lock ordering. The
security property, that deleting a consent revokes the refresh family, needs
only one trigger. The lock buys a replayed response for a duplicate concurrent
refresh instead of an `invalid_grant`. Consider removing the lock and keeping
the single consent trigger once the refresh replay window has been observed in
production logs to be sufficient.

**Dynamically registered clients are never cleaned up.** Open DCR creates an
`oauthClient` row per registration with no expiry. Under the auth rate limit
this is slow growth, not a risk, but a periodic delete of clients with no
consent and no token older than some window would keep the table honest.

**Rate-limit buckets are debited before all checks pass.** The global and
per-user buckets are charged even when the per-client bucket rejects the
request. Harmless at current volume.

**Access-token TTL is 60 minutes.** Stored-token revocation now makes theft
detection immediate, so the long TTL is defensible. Revisit only if the token
registry lookup ever becomes a cost concern, in which case a shorter TTL is the
alternative.

## Code structure

**`read-service.ts` is one thousand lines.** It holds cursor codecs, URL
builders, eight read functions, and the search serializer. Splitting into
`cursors.ts`, `links.ts`, `events.ts`, `transcripts.ts`, and `search.ts` would
cost nothing and make ownership obvious. Do it when the next feature touches
the file rather than as a standalone change.

**Lookup cursors require an exact id-and-name match.** Renaming a recorder or
location between pages returns `invalid_cursor`. Match on id alone.

**Event cursors reject years outside 1900 to 2100.** Fine for this archive;
noted so nobody hunts for it later.

## Documentation

**The tool reference is hand-maintained.** `mcp-tools.md` reproduces the zod
schemas and example JSON by hand and drifted several times during the review
week. Either generate the per-tool section from `output-schemas.ts` and the
registrar descriptions, or trim it to prose and point at `tools/list` for the
exact shapes.

## Product

**`get_transcript` carries no recording duration.** The field was removed
because the transcript-file value was always null in production. The catalog
entry's `durationHms` could be added to the transcript result if usage
telemetry shows agents calling `get_recording` right after `get_transcript`
only to fetch the length, or making poor page-versus-full choices.
