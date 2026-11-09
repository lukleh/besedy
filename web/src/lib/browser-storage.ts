type BrowserStorage = 'localStorage' | 'sessionStorage';

/** Optional browser persistence must not turn a working action into a failure. */
export function readStoredString(key: string, storage: BrowserStorage = 'localStorage'): string | null {
  try { return globalThis[storage].getItem(key); } catch { return null; }
}

export function writeStoredString(key: string, value: string, storage: BrowserStorage = 'localStorage'): void {
  try { globalThis[storage].setItem(key, value); } catch { /* Storage is optional. */ }
}

export function removeStoredValue(key: string, storage: BrowserStorage = 'localStorage'): void {
  try { globalThis[storage].removeItem(key); } catch { /* Storage is optional. */ }
}
