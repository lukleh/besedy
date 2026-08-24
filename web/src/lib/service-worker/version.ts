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
  if (normalizedWebVersion) return normalizedWebVersion;

  // Content fingerprints and commit hashes are different identity domains.
  // Falling back to a commit while a fingerprinted client is running creates a
  // permanent false mismatch during mixed-version deployments.
  const normalizedClientVersion = normalizeWebVersion(clientVersion);
  if (normalizedClientVersion?.startsWith("web-v")) return null;
  return normalizeWebVersion(commit);
}
