import { getSupportEmail } from "./runtime-config";

/**
 * Open mailto link with support email.
 * Call this from onClick handlers only - never expose in HTML/href.
 */
export function openSupportEmail(): void {
  const email = getSupportEmail();
  window.location.href = `mailto:${email}`;
}
