/** One-time reset of browser state that predates the current storage contracts. */
const CURRENT_BROWSER_STORAGE = "besedy-browser-storage-v1";

export function migrateBrowserStorage(): void {
  if (typeof window === "undefined") return;
  try {
    if (localStorage.getItem(CURRENT_BROWSER_STORAGE) === "1") return;
    for (const key of [
      "besedy-timestamps", "besedy-speaker-labels",
      "besedy-sw-update-dismissed", "besedy-sw-update-dismissed-deadline",
    ]) localStorage.removeItem(key);
    localStorage.setItem(CURRENT_BROWSER_STORAGE, "1");
  } catch {
    // Storage restrictions must not prevent opening the current application.
  }
}
