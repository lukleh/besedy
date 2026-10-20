/**
 * The correction page under the ADR 0012 data contract: consent, starting from
 * a batched machine transcript, the speech strip with speech the model wrote
 * nothing for, flags, empty spans and playback controls.
 *
 * Recording ab00004dab has a faster-whisper transcript in the production shape
 * (see tests/e2e/scripts/generate-transcripts.ts), so a workspace can start.
 */

import { test, expect } from "./helpers/base-test";
import { loginAs } from "./helpers/auth";
import { TEST_AUDIO_FILES, TEST_CATALOG_ID } from "./helpers/fixtures";
import { waitForPageReady } from "./helpers/navigation";

const recording = TEST_AUDIO_FILES.find((file) => file.shortHash === "ab00004dab")!;
const correctionPath = `/catalog/${TEST_CATALOG_ID}/recording/${recording.hash}/correction`;

test.describe("transcript correction", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a corrector consents, starts and works through spans", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "Desktop Chrome", "The correction page needs a large landscape screen");

    // A workspace starts only once the catalog has its own guide.
    await loginAs(page, "superadmin");
    const guide = await page.request.put(`/api/catalogs/${TEST_CATALOG_ID}/correction-guide`, {
      data: { body: "# Návod\n\nPište, co zaznělo." },
    });
    expect(guide.ok()).toBeTruthy();

    await loginAs(page, "editor");
    await page.goto(correctionPath);
    await waitForPageReady(page);

    // A retried run may find consent given or the workspace started, so wait
    // for whichever state the page is in rather than assume the first one.
    const consent = page.getByTestId("correction-consent");
    const start = page.getByRole("button", { name: /Začít korekturu|Start correction/ });
    const strip = page.getByTestId("correction-span-audio");
    await expect(consent.or(start).or(strip)).toBeVisible({ timeout: 20000 });
    if (await consent.isVisible()) {
      await expect(consent).toContainText(/trénování/);
      await consent.getByRole("button", { name: /Souhlasím|I agree/ }).click();
      await expect(start.or(strip)).toBeVisible({ timeout: 20000 });
    }
    if (await start.isVisible()) {
      await start.click();
    }
    await expect(strip).toBeVisible({ timeout: 20000 });
    const spanList = page.locator("aside");
    await spanList.getByRole("button", { name: /^0:00/ }).first().click();
    await expect(page.getByRole("textbox").first()).toHaveValue("Dobrý den, vítejte.");

    // The second span holds a region the model wrote nothing for.
    await spanList.getByRole("button", { name: /^0:10/ }).first().click();
    await expect(page.getByRole("textbox").first()).toHaveValue("Dnes budeme mluvit.");
    await expect(page.getByTestId("correction-region-without-text")).toHaveCount(1);
    await expect(page.getByTestId("correction-speech-without-text")).toBeVisible();
    await expect(page.getByTestId("correction-previous-context")).toContainText("vítejte");

    // A flag toggles, and shows its new state once the server has it.
    const unclear = page.getByTestId("correction-flag-UNCLEAR");
    const wasSet = (await unclear.getAttribute("aria-pressed")) === "true";
    await unclear.click();
    await expect(unclear).toHaveAttribute("aria-pressed", wasSet ? "false" : "true");

    // Slowing down cycles the playback rate.
    const rate = page.getByTestId("correction-rate");
    await expect(rate).toHaveText(/1×/);
    await rate.click();
    await expect(rate).toHaveText(/0[,.]8×/);
    // Back to 1× so the approval below reports an unslowed playback.
    await rate.click();
    await expect(rate).toHaveText(/0[,.]6×/);
    await rate.click();
    await expect(rate).toHaveText(/1×/);

    // A span with nothing written asks whether anything was said.
    await spanList.getByRole("button", { name: /^0:49/ }).first().click();
    await expect(page.getByTestId("correction-empty-span")).toBeVisible();
    await expect(page.getByRole("button", { name: /Nic tu nezaznělo|Nothing was said here/ })).toBeVisible();

    // Approving reports playback; the server refuses an approval without it.
    await spanList.getByRole("button", { name: /^0:00/ }).first().click();
    await expect(page.getByRole("textbox").first()).toHaveValue("Dobrý den, vítejte.");
    const approved = page.waitForResponse(
      (response) => response.url().includes("/correction/spans/") && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: /Schválit a pokračovat|Approve and continue/ }).click();
    const response = await approved;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toMatchObject({
      action: "approve",
      playback: { heardFraction: expect.any(Number), minPlaybackRate: 1, maxPlaybackRate: 1 },
    });
  });
});
