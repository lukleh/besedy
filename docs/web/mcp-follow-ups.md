# Besedy MCP Follow-ups

> Last updated: 2026-09-02

Deferred items from the MCP review that landed as PR #90. None of these blocks
deployment. Each entry records what was found, why it was left, and what would
make it worth doing. Remove an entry when it ships or when the reason to defer
becomes permanent.

Decided and closed on 2026-09-02, so they are not listed: the refresh-token
advisory lock stays because it fixes a real concurrent-refresh incident (see the
Authentication section of [mcp-server.md](mcp-server.md)); the unused
trusted-client trigger branches were removed instead; the 60-minute access-token
TTL is acceptable now that stored-token revocation is immediate; the order in
which rate-limit buckets are debited and the 1900 to 2100 bound on event cursor
years are not worth changing.

## Test coverage

**Retention and migration tests are string matches.** The tests for
`mcp-usage-retention.sh` and the consent-revocation triggers assert substrings
of SQL and never execute it. One integration test against the disposable test
database would make them meaningful.

## Authorization

**Dynamically registered clients are never cleaned up.** Open DCR creates an
`oauthClient` row per registration with no expiry. Under the auth rate limit
this is slow growth, not a risk, but a periodic delete of clients with no
consent and no token older than some window would keep the table honest.

## Code structure

**`read-service.ts` is one thousand lines.** It holds cursor codecs, URL
builders, eight read functions, and the search serializer. Splitting into
`cursors.ts`, `links.ts`, `events.ts`, `transcripts.ts`, and `search.ts` would
cost nothing and make ownership obvious. Do it when the next feature touches
the file rather than as a standalone change.

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
