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

  test("a corrector consents, starts and works through spans @smoke", async ({ page }, testInfo) => {
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
    const audio = page.locator("audio").first();
    const spanControls = page.getByTestId("correction-span-audio");
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
    await expect(page.getByTestId("sleep-timer-button")).toHaveCount(0);

    await spanControls.getByRole("button", { name: /^(Přehrát úsek|Play span)$/ }).click();
    const pauseSpan = spanControls.getByRole("button", { name: /Pozastavit úsek|Pause span/ });
    await expect(pauseSpan).toBeVisible();
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0.2);
    await pauseSpan.click();
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
    const pausedAt = await audio.evaluate((element: HTMLAudioElement) => element.currentTime);
    await spanControls.getByRole("button", { name: /Pokračovat v úseku|Resume span/ }).click();
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(pausedAt);

    // The second span holds a region the model wrote nothing for.
    await spanList.getByRole("button", { name: /^0:10/ }).first().click();
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
    await expect(page.getByRole("textbox").first()).toHaveValue("Dnes budeme mluvit.");
    await expect(page.getByTestId("correction-region-without-text")).toHaveCount(1);
    await expect(page.getByTestId("correction-speech-without-text")).toBeVisible();
    await expect(page.getByTestId("correction-previous-context")).toContainText("vítejte");

    // Unsubmitted work survives both span navigation and a page reload, and
    // remains local: saving a draft must never approve text on the server.
    const editor = page.getByRole("textbox").first();
    const comment = page.getByRole("textbox").nth(1);
    await editor.fill("Rozpracovaná oprava.");
    await comment.fill("Ověřit jméno.");
    await spanList.getByRole("button", { name: /^0:00/ }).first().click();
    await spanList.getByRole("button", { name: /^0:10/ }).first().click();
    await expect(editor).toHaveValue("Rozpracovaná oprava.");
    await expect(comment).toHaveValue("Ověřit jméno.");
    page.once("dialog", (dialog) => dialog.accept());
    await page.reload();
    await expect(strip).toBeVisible({ timeout: 20000 });
    await spanList.getByRole("button", { name: /^0:10/ }).first().click();
    await expect(editor).toHaveValue("Rozpracovaná oprava.");
    await expect(comment).toHaveValue("Ověřit jméno.");
    const stored = await page.request.get(`/api/catalogs/${TEST_CATALOG_ID}/recordings/${recording.hash}/correction/spans`);
    expect((await stored.json()).spans[1].text).toBe("Dnes budeme mluvit.");
    await editor.fill("Dnes budeme mluvit.");
    await comment.fill("");

    // When session storage is full, the app still owns drafts while the
    // responsive layout or client-side navigation unmounts the editor.
    const restoreStorage = await page.evaluateHandle(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("besedy-correction-drafts:")) {
          throw new DOMException("Storage full", "QuotaExceededError");
        }
        return setItem.call(this, key, value);
      };
      return () => { Storage.prototype.setItem = setItem; };
    });
    try {
      await editor.fill("Oprava v paměti.");
      await comment.fill("Poznámka v paměti.");
      await page.setViewportSize({ width: 800, height: 1000 });
      await expect(strip).toHaveCount(0);
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(strip).toBeVisible();
      await spanList.getByRole("button", { name: /^0:10/ }).first().click();
      await expect(editor).toHaveValue("Oprava v paměti.");
      await expect(comment).toHaveValue("Poznámka v paměti.");

      await page.getByTestId("header-back").click();
      await expect(page).toHaveURL(`/catalog/${TEST_CATALOG_ID}/correction`);
      await page.locator(`a[href="${correctionPath}"]`).first().click();
      await expect(strip).toBeVisible();
      await spanList.getByRole("button", { name: /^0:10/ }).first().click();
      await expect(editor).toHaveValue("Oprava v paměti.");
      await expect(comment).toHaveValue("Poznámka v paměti.");
      await editor.fill("Dnes budeme mluvit.");
      await comment.fill("");
    } finally {
      await restoreStorage.evaluate((restore) => restore());
      await restoreStorage.dispose();
    }

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

    // Approving waits until most of the span was heard, then reports the
    // playback; the server refuses an approval without a report.
    await spanList.getByRole("button", { name: /^0:00/ }).first().click();
    await expect(page.getByRole("textbox").first()).toHaveValue("Dobrý den, vítejte.");
    const approve = page.getByTestId("correction-approve");
    await expect(approve).toBeDisabled();
    // Selecting a span only prepares it. Start its ten seconds explicitly.
    await spanControls.getByRole("button", { name: /^(Přehrát úsek|Play span)$/ }).click();
    await expect(approve).toBeEnabled({ timeout: 30000 });
    const approved = page.waitForResponse(
      (response) => response.url().includes("/correction/spans/") && response.request().method() === "POST"
    );
    await approve.click();
    const response = await approved;
    expect(response.status()).toBe(200);
    const body = response.request().postDataJSON() as {
      action: string;
      playback: { heardFraction: number; minPlaybackRate: number; maxPlaybackRate: number };
    };
    expect(body).toMatchObject({
      action: "approve",
      playback: { minPlaybackRate: 1, maxPlaybackRate: 1 },
    });
    expect(body.playback.heardFraction).toBeGreaterThanOrEqual(0.9);
  });
});
