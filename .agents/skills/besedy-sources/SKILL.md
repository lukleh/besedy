---
name: besedy-sources
description: Explore the Besedy transcript corpus to explain topics, compare discussions, trace relationships and models, and surface practical perspectives with grounded recording links. Use when the user asks what is said in Besedy recordings or wants to study their content.
---

# Besedy Sources

Treat Besedy as a study corpus containing many long recordings, not as a small
lookup database. Help the user understand and explore the material rather than
presenting a single passage as a final verdict.

## Ground answers in Besedy

Use the declared Besedy MCP tools as the source for claims about Besedy content.
Before answering a content question, confirm that the tools needed for transcript
search are available. When the connection is missing, authentication is required,
or the user's permissions do not include transcript access, explain that plainly.
Do not replace missing Besedy evidence with general knowledge or imply that an
ungrounded answer came from the recordings.

On a Codex host, help a user connect a missing dependency with
`codex mcp add besedy --url https://besedy.org/api/mcp`, followed by
`codex mcp login besedy` for OAuth. Installing this skill alone does not perform
those configuration or authentication steps.

Search in the user's language. For Czech requests, search in Czech. Base the
grounded synthesis on returned Besedy passages and their verified transcript
context. If relevant material is not found, say so and offer a narrower topic or
different search terms.

Use the MCP tools according to the task:

- Use `who_am_i` and `list_catalogs` when the active account, catalog, or access
  level is unclear.
- Use `list_events`, `list_locations`, and `list_recorders` for questions tied to
  dates, events, venues, or recorders and to resolve metadata filters.
- Use `search_transcripts` for semantic discovery across recordings.
- Use `get_transcript` to verify a candidate in continuous source context.
- Use `get_event` and `get_recording` to understand event associations and
  distinguish multiple recordings of one discussion.

Follow the live tool descriptions and schemas for exact arguments, limits, and
continuations. Do not assume that every authenticated user has access to every
catalog or transcript tool.

## Search for meaning, then verify context

For a broad or exploratory question, do not normally synthesize from the first
search result. Search iteratively using the user's wording, close synonyms,
related concepts, and useful terminology discovered in earlier results. Look for
connections, explanatory models, analogies, practical suggestions, and
materially different treatments of the topic.

Treat semantic-search results as a discovery pool. Their order is relevance
within that search, not confidence or evidence strength. A low
`maxPerRecording`, often `1`, improves diversity during corpus-wide discovery.
Use smaller, focused follow-up searches instead of repeatedly requesting the
largest result set. When the user asks about a known event, location, recorder,
or year, resolve and apply the corresponding metadata filter.

Every search hit points into an indexed transcript chunk. Adjacent chunks help
with triage but can cross conversational boundaries. Before relying on a
shortlisted passage, pass its `transcriptRequest` to `get_transcript` and read a
continuous window around it. Expand the window until the question, setup,
answer, analogy, qualifications, and conclusion are coherent. Use a smaller
window only for an exact, low-ambiguity lookup.

If a discussion develops elsewhere in one promising recording, make a focused
follow-up search using its event ID or audio hash. Do not read an entire
multi-hour transcript by default; expand selectively until the relevant
discussion arc is understood.

Do not quote or paraphrase a search fragment as authoritative when continuous
context changes, narrows, contradicts, or leaves its meaning unresolved.

## Distinguish events, recordings, and transcript variants

Different audio hashes may be recorder variants of the same Besedy event. They
are not independent evidence. Use event and recording metadata to identify the
underlying discussion, prefer the primary or clearest recording, and treat its
variants as one source.

Describe an idea as recurring only when at least two distinct Besedy events
support it. Otherwise attribute it to the specific discussion. Preserve
differences and tensions between events instead of flattening them into false
consensus.

When an important passage is badly transcribed and `get_transcript` reports
other backends, compare the same time window in another backend. Keep any direct
quotation contiguous and grounded in one returned transcript version.

## Present a useful map of the material

Group the strongest passages into themes and explain how their models,
analogies, relationships, and practical suggestions connect. Clearly separate
what the recordings support from inference. When the user asks for advice,
present it as perspectives found in Besedy, not as objective or professional
direction.

Begin a grounded answer with a brief, natural indication that it comes from
Besedy transcripts. Include direct timestamped recording links for the passages
that support the main claims. Prefer the segment `webUrl` returned by the
verified transcript over the original search-result link. A concise answer
normally needs two to five carefully selected links rather than every candidate.

For broad questions, end with a small number of promising directions the user
could explore next. Preserve uncertainty where transcription or coverage is
unclear and do not describe a non-exhaustive search as proof that the corpus
contains nothing else.
