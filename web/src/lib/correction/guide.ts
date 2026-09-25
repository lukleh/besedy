import prisma from "@/lib/db";

/**
 * The convention correctors share before the pilot starts.
 *
 * It is a catalog's own text once an administrator writes one; until then this
 * is what the correction surface shows, so nobody has to invent a house style
 * span by span.
 */
export const DEFAULT_CORRECTION_GUIDE = `# Correction guide

Aim for a faithful, readable transcript.

- Correct misheard words, names, numbers, capitalization and punctuation.
- Preserve meaning, wording, uncertainty and meaningful repetition.
- Do not improve style, and do not correct factual or grammatical mistakes the
  speaker actually made.
- Use ordinary orthography without erasing meaningful dialect or unusual word
  choice.
- Omit incidental fillers or false starts only when meaning, emphasis and
  character are unchanged.
- Do not guess when the audio is unclear. Disapprove the span and, if it helps,
  leave a comment.
- Do not introduce ad-hoc markers such as \`[unintelligible]\`.
`;

export interface CorrectionGuide {
  revisionId: string | null;
  body: string;
  authorId: string | null;
  updatedAt: Date | null;
  isDefault: boolean;
}

export async function getActiveGuide(
  catalogId: string
): Promise<CorrectionGuide> {
  const revision = await prisma.transcriptGuideRevision.findFirst({
    where: { workflowGroupId: catalogId },
    orderBy: { createdAt: "desc" },
    select: { id: true, body: true, authorId: true, createdAt: true },
  });

  if (!revision) {
    return {
      revisionId: null,
      body: DEFAULT_CORRECTION_GUIDE,
      authorId: null,
      updatedAt: null,
      isDefault: true,
    };
  }

  return {
    revisionId: revision.id,
    body: revision.body,
    authorId: revision.authorId,
    updatedAt: revision.createdAt,
    isDefault: false,
  };
}

export async function getActiveGuideRevisionId(
  catalogId: string
): Promise<string | null> {
  const revision = await prisma.transcriptGuideRevision.findFirst({
    where: { workflowGroupId: catalogId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return revision?.id ?? null;
}

/**
 * Guide edits are append-only and take effect immediately. They never
 * invalidate a decision: people agreed about words, not about a document.
 */
export async function appendGuideRevision(
  catalogId: string,
  body: string,
  authorId: string
): Promise<CorrectionGuide> {
  const revision = await prisma.transcriptGuideRevision.create({
    data: { workflowGroupId: catalogId, body: body.trim(), authorId },
    select: { id: true, body: true, authorId: true, createdAt: true },
  });

  return {
    revisionId: revision.id,
    body: revision.body,
    authorId: revision.authorId,
    updatedAt: revision.createdAt,
    isDefault: false,
  };
}
