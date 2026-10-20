import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { CorrectionError } from "@/lib/correction/errors";

/**
 * The contributor terms a person accepts before any correction write
 * (ADR 0012). Corrections are human work that is published and used to train
 * models, so the acceptance is recorded once per person and terms version,
 * with the exact text that was shown. Changing the text needs a new version.
 */
export const CONTRIBUTOR_TERMS = {
  version: "2026-10-20",
  text: "Souhlasím, že mé opravy přepisů mohou být zveřejněny a použity k trénování modelů pro přepis řeči. U každého schválení nebo zamítnutí se zaznamenává, jakou část úseku jsem si poslechl(a) a jakou rychlostí přehrávání. Po smazání mého účtu zůstanou mé opravy a komentáře zachovány; jsou uložené pod interním identifikátorem, ne pod mým jménem nebo e-mailem.",
} as const;

type Client = Prisma.TransactionClient | typeof prisma;

export interface ContributorConsentState {
  accepted: boolean;
  acceptedAt: Date | null;
  version: string;
  text: string;
}

export async function getContributorConsent(
  actorKey: string,
  client: Client = prisma
): Promise<ContributorConsentState> {
  const consent = await client.transcriptContributorConsent.findUnique({
    where: {
      actorKey_termsVersion: { actorKey, termsVersion: CONTRIBUTOR_TERMS.version },
    },
    select: { acceptedAt: true },
  });
  return {
    accepted: consent !== null,
    acceptedAt: consent?.acceptedAt ?? null,
    version: CONTRIBUTOR_TERMS.version,
    text: CONTRIBUTOR_TERMS.text,
  };
}

/** Record acceptance of the current terms; accepting twice keeps the first. */
export async function acceptContributorTerms(userId: string): Promise<ContributorConsentState> {
  await prisma.transcriptContributorConsent.upsert({
    where: {
      actorKey_termsVersion: { actorKey: userId, termsVersion: CONTRIBUTOR_TERMS.version },
    },
    create: {
      actorKey: userId,
      userId,
      termsVersion: CONTRIBUTOR_TERMS.version,
      termsText: CONTRIBUTOR_TERMS.text,
    },
    update: {},
  });
  return getContributorConsent(userId);
}

/** Every correction write calls this inside its transaction. */
export async function requireContributorConsent(
  client: Client,
  actorKey: string
): Promise<void> {
  const consent = await getContributorConsent(actorKey, client);
  if (!consent.accepted) {
    throw new CorrectionError(
      "CONSENT_REQUIRED",
      "Accept the contributor terms before correcting transcripts",
      { termsVersion: CONTRIBUTOR_TERMS.version }
    );
  }
}
