import { createHash } from "node:crypto";

/**
 * Canonical form of span text.
 *
 * The server decides whether text changed, so it has to agree with itself
 * about what "the same text" means. Unicode form, line endings and whitespace
 * runs are canonicalized; capitalization, punctuation and words are left
 * alone, because in a transcript those carry meaning.
 *
 * A span is one utterance, so an internal line break is a typing artifact
 * rather than structure, and it collapses to a space like any other run.
 */
export function normalizeSpanText(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\s ᠎​﻿]+/g, " ")
    .trim();
}

/** SHA-256 of the normalized text, used as an integrity check on decisions. */
export function hashSpanText(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * A publishable revision is non-empty. v1 has no unintelligible marker and no
 * intentional empty outcome: someone who cannot make out the words disapproves
 * instead of guessing.
 */
export function isPublishableSpanText(normalized: string): boolean {
  return normalized.length > 0;
}

/** Content-derived fingerprint of a rendered artifact. */
export function fingerprintContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
