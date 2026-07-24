/**
 * DOM mutation helpers for testing resilience to browser extensions
 *
 * Simulates Google Translate's DOM manipulation behavior for E2E tests.
 */

import { Page } from "@playwright/test";

// Elements to skip when wrapping text nodes (would break form controls)
const SKIP_ELEMENTS = [
  "SCRIPT",
  "STYLE",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "OPTION",
  "NOSCRIPT",
  "IFRAME",
];

/**
 * Simulates Google Translate by wrapping text nodes in <font> tags
 * and adding translation classes to <html>.
 *
 * This mimics the DOM modifications that Google Translate makes:
 * - Adds "translated-ltr" class to <html>
 * - Wraps text nodes in <font> tags with inline styles
 *
 * @param page - Playwright page object
 */
export async function simulateGoogleTranslate(page: Page): Promise<void> {
  await page.evaluate((skipElements) => {
    // Add Google Translate class to indicate translation is active
    document.documentElement.classList.add("translated-ltr");

    // Wrap text nodes in font tags (Google Translate behavior)
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    );

    const textNodes: Text[] = [];
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const parent = node.parentElement;
      if (
        node.textContent?.trim() &&
        parent &&
        !skipElements.includes(parent.tagName) &&
        !parent.closest("[contenteditable]") &&
        !parent.closest("[translate='no']")
      ) {
        textNodes.push(node);
      }
    }

    // Only wrap a subset of text nodes to avoid breaking everything
    // This simulates partial translation (Google Translate doesn't always wrap all nodes)
    textNodes.slice(0, 50).forEach((textNode) => {
      const parent = textNode.parentNode;
      if (parent) {
        const font = document.createElement("font");
        font.style.cssText = "vertical-align: inherit;";
        parent.replaceChild(font, textNode);
        font.appendChild(textNode);
      }
    });
  }, SKIP_ELEMENTS);
}

/**
 * Clears Google Translate simulation by removing the translation classes.
 *
 * Note: This does NOT unwrap the font tags - once the DOM is mutated,
 * it stays mutated (just like real Google Translate).
 *
 * @param page - Playwright page object
 */
export async function clearGoogleTranslate(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.classList.remove("translated-ltr", "translated-rtl");
  });
}

/**
 * Checks if the page has Google Translate indicators present.
 *
 * @param page - Playwright page object
 * @returns true if translation indicators are detected
 */
export async function isGoogleTranslateActive(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const html = document.documentElement;
    return (
      html.classList.contains("translated-ltr") ||
      html.classList.contains("translated-rtl") ||
      document.getElementById("goog-gt-tt") !== null ||
      document.querySelector("iframe.goog-te-banner-frame") !== null
    );
  });
}

/**
 * Simulates a more aggressive DOM mutation (like some browser extensions).
 * Injects extra wrapper divs around interactive elements.
 *
 * @param page - Playwright page object
 */
export async function simulateAggressiveExtension(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Find all buttons and wrap them in extra divs (some extensions do this)
    const buttons = document.querySelectorAll("button:not([data-wrapped])");
    buttons.forEach((button, index) => {
      if (index < 10) {
        // Limit to first 10 to avoid breaking too much
        const wrapper = document.createElement("div");
        wrapper.className = "extension-wrapper";
        wrapper.style.display = "contents"; // Shouldn't affect layout
        button.setAttribute("data-wrapped", "true");
        button.parentNode?.insertBefore(wrapper, button);
        wrapper.appendChild(button);
      }
    });
  });
}
