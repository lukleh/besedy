import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db";

/**
 * The convention correctors share, as ADR 0012 fixes it.
 *
 * It is what the settings page offers until a catalog administrator saves the
 * catalog's own guide; a workspace cannot start before one is saved, so every
 * revision records the guide it followed. The corrector's text is the truth;
 * the guide recommends how to write it.
 */
export const DEFAULT_CORRECTION_GUIDE = `# Návod pro korektury

Text korektora je pravda: zapište, co v úseku zaznělo.

## Co a jak psát

- Opravte špatně slyšená slova, jména, čísla, velká písmena a interpunkci.
- Pište, co zaznělo. Neopravujte styl ani gramatické či věcné chyby mluvčího.
- **Vycpávková slova** pište tak, jak zazněla, a jen těmito zápisy: „ehm“,
  „eee“, „hm“, „mhm“. Slova „no“ a „jo“ jsou běžná slova a píšou se vždy.
- **Useknutá slova, opakování a opravené začátky** pište tak, jak zazněly:
  „Šli jsme do pro- protože pršelo.“ „Já jsem šel, já jsem jel do Prahy.“
- **Čísla** pište číslicemi: „2 hodiny“, „v roce 1989“, „7. června“, „v 8:30“,
  „50 %“, „3. kapitola“. Slovem zůstávají „jeden“, „jedna“, „jedno“ a ustálená
  spojení jako „jednou“ nebo „ani jeden“.
- **Cizí slova** pište v původním pravopisu s českou koncovkou: „mindfulness“,
  „na workshopu“. Slova, která čeština převzala a slovník je píše česky, pište
  česky: „víkend“.
- Slovo useknuté na hranici úseku patří do úseku, kde ho slyšíte víc.

## Prázdné úseky a problémová místa

- Když v úseku nikdo nemluví (šum, hudba, ticho), smažte text a schvalte.
  Prázdný úsek znamená, že nic nezaznělo.
- Nesrozumitelnou řeč nehádejte. Napište, co je jasné, a označte úsek příznakem
  „nesrozumitelné“. Stejně označte překryv mluvčích, jiný jazyk a hudbu nebo
  šum přes řeč.
- Nepoužívejte vlastní značky jako „[nesrozumitelné]“.
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
  catalogId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<string | null> {
  const revision = await client.transcriptGuideRevision.findFirst({
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
