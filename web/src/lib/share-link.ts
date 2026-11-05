import { copyToClipboard } from "@/lib/clipboard";

export type ShareLinkOutcome = "shared" | "copied" | "cancelled";

// Phones and tablets have a system share sheet people expect. On a desktop
// the sheet is unfamiliar and often lacks the apps people send links with,
// so the link is copied instead.
function prefersShareSheet(): boolean {
  return typeof navigator.share === "function"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(pointer: coarse)").matches;
}

/**
 * Share a link through the system share sheet on touch devices, and copy it
 * elsewhere. Rejects only when the link could be neither shared nor copied.
 */
export async function shareOrCopyLink(url: string): Promise<ShareLinkOutcome> {
  if (prefersShareSheet()) {
    try {
      await navigator.share({ url });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
      // The sheet was refused (no user activation, a policy): copy instead.
    }
  }
  await copyToClipboard(url);
  return "copied";
}
