---
name: besedy-sources
description: Explore the Besedy transcript corpus to explain topics, compare discussions, trace relationships and models, and surface practical perspectives with grounded recording links. Use when the user asks what is said in Besedy recordings or wants to study their content.
---

# Besedy Sources

Use this optional skill to make Besedy research easier to discover and to present
the resulting evidence as a useful map of the material. The Besedy MCP server,
tool descriptions, schemas, and results remain the authoritative and complete
guide to selecting and calling tools; do not replace or duplicate their live
operational rules here.

## Ground answers in Besedy

Use the declared Besedy MCP tools as the source for claims about Besedy content.
When the connection is missing or authentication is required, explain that
plainly. Do not replace missing Besedy evidence with general knowledge or imply
that an ungrounded answer came from the recordings.

On a Codex host, help a user connect a missing dependency with
`codex mcp add besedy --url https://besedy.org/api/mcp`, followed by
`codex mcp login besedy` for OAuth. Installing this skill alone does not perform
those configuration or authentication steps.

Follow the live MCP guidance for tool choice, catalog resolution, search scope,
evidence verification, and citations. Search in the user's language. If relevant
material is not found, say so without turning missing evidence into a stronger
claim than the MCP results support.

## Explore the material

For broad questions, look beyond the first useful passage for connections,
explanatory models, analogies, practical suggestions, and materially different
treatments of the topic. Use dates, events, locations, recorders, and recordings
to focus exploration when they help. Stop when the returned and verified evidence
adequately covers the user's request; disclose material coverage limits.

Prefer the clearest recording when the MCP results identify variants. Preserve
differences and tensions between distinct discussions instead of flattening them
into false consensus. When an important passage is badly transcribed and another
backend is available, compare the same time window before quoting it.

## Present a useful map of the material

Group the strongest verified passages into themes and explain how their models,
analogies, relationships, and practical suggestions connect. Clearly separate
what the recordings support from inference. When the user asks for advice,
present it as perspectives found in Besedy, not as objective or professional
direction.

Begin a grounded answer with a brief, natural indication that it comes from
Besedy transcripts. Include direct timestamped recording links for the passages
that support the main claims. A concise answer normally needs two to five
carefully selected links rather than every candidate.

For broad questions, end with a small number of promising directions the user
could explore next. Preserve uncertainty where transcription or coverage is
unclear.
