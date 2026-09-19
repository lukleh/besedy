const UNITS = ["B", "kB", "MB", "GB", "TB"] as const;

/** Human-readable byte count using SI units, e.g. "48.2 MB". */
export function formatBytes(bytes: number, locale?: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < UNITS.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : value >= 100 ? 0 : 1;
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value);
  return `${formatted} ${UNITS[unitIndex]}`;
}
