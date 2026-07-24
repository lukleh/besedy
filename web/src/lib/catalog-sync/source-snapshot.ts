import { createHash } from 'node:crypto';
import fs from 'fs/promises';

export const SOURCE_FINGERPRINT_VERSION = 'v3';

export interface SourceSnapshot {
  content: string;
  fingerprint: string;
}

/**
 * Build a content generation identifier for a catalog source.
 *
 * Earlier fingerprints used file size, mtime, and the resolved path. Those
 * attributes are useful cache hints but are not an identity: deployments can
 * preserve them while replacing a file. A versioned SHA-256 makes the stored
 * projection generation depend only on the bytes that were parsed.
 */
export function buildSourceFingerprint(content: string | Uint8Array): string {
  const digest = createHash('sha256').update(content).digest('hex');
  return `${SOURCE_FINGERPRINT_VERSION}:sha256:${digest}`;
}

/** Read a source exactly once so fingerprinting and parsing use identical bytes. */
export async function readSourceSnapshot(
  filePath: string,
): Promise<SourceSnapshot> {
  const bytes = await fs.readFile(filePath);
  return {
    content: bytes.toString('utf-8'),
    fingerprint: buildSourceFingerprint(bytes),
  };
}
