/** The deployment fingerprint emitted by scripts/resolve_web_version.sh. */
export function normalizeWebVersion(version: string | null | undefined): string | null {
  return version && /^web-v2-[a-f0-9]{40}$/.test(version) ? version : null;
}
