/**
 * Copy text to clipboard with fallback for older browsers.
 *
 * Uses navigator.clipboard when available (requires secure context),
 * falls back to textarea/execCommand for older browsers.
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
    document.execCommand("copy");
    document.body.removeChild(textarea);
    return;
  }

  await navigator.clipboard.writeText(text);
}
