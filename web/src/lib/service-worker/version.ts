export function normalizeWebVersion(version: string | null | undefined): string | null {
  if (!version || version === "unknown") return null;
  return version;
}

export function selectObservedWebVersion(
  webVersion: string | null | undefined,
  commit: string | null | undefined,
  clientVersion: string | null | undefined
): string | null {
  const normalizedWebVersion = normalizeWebVersion(webVersion);
  const normalizedClientVersion = normalizeWebVersion(clientVersion);
  if (normalizedClientVersion?.startsWith("web-v")) {
    // Content fingerprints and commit hashes are different identity domains.
    // Older servers can expose their commit through either field, so accept
    // only a fingerprint while a fingerprinted client is running.
    return normalizedWebVersion?.startsWith("web-v") ? normalizedWebVersion : null;
  }

  if (normalizedWebVersion) return normalizedWebVersion;
  return normalizeWebVersion(commit);
}
