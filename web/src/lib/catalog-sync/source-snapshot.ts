import { createHash } from 'node:crypto';
import fs from 'fs/promises';

/**
 * Part of every stored fingerprint. Bump it when sync starts reading
 * something new from unchanged sources: the next sync then sees every source
 * as changed and rebuilds it once, instead of skipping a file whose bytes
 * are the same. v6 requires complete current headers and the decoded-audio hash contract.
 */
export const SOURCE_FINGERPRINT_VERSION = 'v6';

export interface SourceSnapshot {
  content: string;
  fingerprint: string;
}

/** Hash the exact parsed source bytes under the current projection contract. */
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
