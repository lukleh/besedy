/**
 * Copy text to clipboard with fallback for older browsers.
 *
 * Uses navigator.clipboard when available (requires secure context),
 * falls back to textarea/execCommand for older browsers. Rejects when the
 * text could not be copied, in either path.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard) {
    // Fallback for older browsers
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
    // execCommand reports a refused copy by returning false, not by throwing.
    if (!copied) throw new Error("Copy to clipboard was refused");
    return;
  }

  await navigator.clipboard.writeText(text);
}
