# ADR 0010: The event page previews draft posters for privileged actors

- **Status:** Accepted
- **Date:** 2026-09-20
- **Canonical references:** [ADR 0009](0009-event-poster-publication.md), [Catalog permission model](0005-catalog-permission-model.md)

## Context

[ADR 0009](0009-event-poster-publication.md) decided that the main event page
"does not accidentally substitute a draft": an actor with draft-candidate
visibility who opened an event with no published poster saw, at most, a text
badge stating a draft existed, plus a link to the separate poster-management
page. The actual draft image was never rendered on the event page itself.

That reads as a safeguard against showing unapproved material where a
published poster is expected, but it does not distinguish between two
different situations:

1. A published poster exists, and a newer, unpublished draft also exists. Here
   substituting the draft for the published image would be genuinely
   misleading — a viewer would see something nobody approved as if it were
   final.
2. Nothing is published yet. Here there is no published image to substitute,
   so withholding the draft protects nothing; it just means a privileged
   actor cannot see what they uploaded without leaving the page.

In practice this second case was reported as a visibility bug: an
administrator with draft-candidate permission could not see draft posters on
an event's own page, even though the same account could see the same
candidates one click away on the poster-management page
(`/catalog/:id/event/:id/poster`), which already serves candidate images
through a permission-gated endpoint
(`GET .../posters/:posterId/image`, `view_candidates`).

## Decision

When an event has **no published poster**, the event-detail response
(`GET /api/catalogs/:id/events/:eventId`) additionally returns the latest
draft candidate's `id`/`label`/`createdAt` to actors with draft-candidate
visibility (`canViewPosterCandidates`), fetched only in that case. The event
page renders that candidate's image using the same permission-gated
candidate-image endpoint the poster-management page already uses, with a
"Draft poster available (not published)" label overlaid on it so it is never
mistaken for a published poster.

This does not change the first case from ADR 0009's context: when a poster
**is** published and a newer draft also exists, the event page continues to
show only the published image, with a badge noting a newer draft is
available. The "no accidental substitution of a live poster" concern still
applies there.

Ordinary readers — without draft-candidate visibility — are unaffected: the
audience endpoint and the event-detail response still expose only published
poster information to them, exactly as ADR 0009 specified.

## Consequences

- Amends the paragraph in ADR 0009's "Read and management APIs" section
  describing the main event page as never substituting a draft; that
  statement now holds only when a poster is already published.
- The event-detail response gains one field, `latestDraftCandidate`, returned
  under the same `canViewPosterCandidates` gate as `posterStatus`, and costs
  one extra query only for events with drafts and no publication.
- `EventPosterPicture` gained a `source: "published" | "candidate"` mode so
  the same component can render either an audience-facing published poster or
  a permission-gated draft candidate, always visibly labeled when it is the
  latter.
- Implemented in [PR #149](https://github.com/lukleh/besedy/pull/149).
