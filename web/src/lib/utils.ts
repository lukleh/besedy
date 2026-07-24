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
