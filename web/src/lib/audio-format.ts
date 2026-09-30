/**
 * Which archive file a browser should play (#291).
 *
 * Every recording has an Opus WebM. iOS Safari loads a WebM audio file whole
 * into its GPU process instead of streaming it, which fails for multi-hour
 * recordings, so WebKit browsers get the AAC-in-MP4 copy when one exists.
 */

/**
 * True for browsers that need the AAC copy: everything on iPhone, iPad and
 * iPod (all browsers there use WebKit) and Safari on macOS, which is also how
 * iPadOS presents itself in desktop mode. Chrome, Firefox and Android keep
 * the WebM.
 */
export function prefersAacAudio(userAgent: string): boolean {
  if (/(?:iPhone|iPad|iPod)/.test(userAgent)) return true;
  return (
    /Macintosh/.test(userAgent) &&
    /Version\/[^ ]+.*Safari\//.test(userAgent) &&
    !/(?:Chrome|Chromium|Edg|Firefox)\//.test(userAgent)
  );
}

/** {@link prefersAacAudio} for the running browser; false on the server. */
export function browserPrefersAacAudio(): boolean {
  return typeof navigator !== "undefined" && prefersAacAudio(navigator.userAgent);
}
