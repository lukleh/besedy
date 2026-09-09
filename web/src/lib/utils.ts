import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Trim the scan root prefix from a full path to get a relative path.
 * If scanRoot is not provided or path doesn't start with it, returns the original path.
 */
export function trimScanRoot(fullPath: string, scanRoot?: string): string {
  if (!scanRoot || !fullPath.startsWith(scanRoot)) {
    return fullPath;
  }
  // Remove scan root and leading slash
  let relative = fullPath.slice(scanRoot.length);
  if (relative.startsWith('/')) {
    relative = relative.slice(1);
  }
  return relative || fullPath;
}

/**
 * Format seconds as HH:MM:SS timestamp.
 */
export function formatTimestamp(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Human-readable decimal (1000-based) byte size, e.g. "58.3 MB".
 */
export function formatBytes(bytes?: number | null): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return null;
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1000;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}
