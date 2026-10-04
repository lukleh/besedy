/**
 * Admin recording ingest: page visibility and API gating.
 *
 * Processing itself needs the host Prefect worker and GPU backends, so these
 * tests only cover who can reach the page and the admin API surface.
 *
 * @tags @smoke
 */

import { test, expect } from "./helpers/base-test";
import { loginAs } from "./helpers/auth";
import { waitForPageReady } from "./helpers/navigation";

test.describe("Admin Ingest @smoke", () => {
  test("admin can open the ingest page from the admin area", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/ingest");
    await waitForPageReady(page);

    await expect(page).toHaveURL(/\/admin\/ingest/);
    await expect(page.getByTestId("admin-ingest-page")).toBeVisible();
    await expect(page.getByTestId("ingest-upload-card")).toBeVisible();
    // Nothing selected yet, so the upload action stays disabled.
    await expect(page.getByTestId("ingest-upload-button")).toBeDisabled();
    await expect(page.locator('a[href="/admin/ingest"]').first()).toBeAttached();
  });

  test("dropping files fills the upload list and skips unsupported ones", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/ingest");
    await waitForPageReady(page);

    const dataTransfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["audio"], "talk.MP3", { type: "audio/mpeg" }));
      transfer.items.add(new File(["text"], "notes.txt", { type: "text/plain" }));
      return transfer;
    });
    await page.getByTestId("ingest-dropzone").dispatchEvent("drop", { dataTransfer });

    const list = page.getByTestId("ingest-upload-list");
    await expect(list).toContainText("talk.MP3");
    await expect(list).not.toContainText("notes.txt");
    // The skipped file is named in a toast; on mobile the toast also carries a
    // screen-reader copy of its description, hence `first()`.
    await expect(page.getByText("notes.txt").first()).toBeVisible();
    await expect(page.getByTestId("ingest-upload-button")).toBeEnabled();
  });

  test("a file dropped outside the drop zone does not leave the page", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/ingest");
    await waitForPageReady(page);

    const blocked = await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["audio"], "talk.mp3", { type: "audio/mpeg" }));
      const drop = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      document.querySelector("h1")?.dispatchEvent(drop);
      return drop.defaultPrevented;
    });

    expect(blocked).toBe(true);
    await expect(page.getByTestId("ingest-upload-list")).toHaveCount(0);
  });

  test("catalog owners are redirected away from the ingest page", async ({ page }) => {
    await loginAs(page, "owner");
    await page.goto("/admin/ingest");
    await waitForPageReady(page);

    await expect(page).not.toHaveURL(/\/admin\/ingest/);
    await expect(page.getByTestId("admin-ingest-page")).toHaveCount(0);
  });

  test("ingest API is admin-only", async ({ page }) => {
    await loginAs(page, "owner");

    const list = await page.request.get("/api/admin/ingest");
    expect(list.status()).toBe(403);

    const create = await page.request.post("/api/admin/ingest/uploads", {
      data: { catalogId: "20260101_000000", filename: "talk.mp3", sizeBytes: 10 },
    });
    expect(create.status()).toBe(403);
  });

  test("admin listing works and validates input", async ({ page }) => {
    await loginAs(page, "admin");

    const list = await page.request.get("/api/admin/ingest?limit=5");
    expect(list.ok()).toBe(true);
    const payload = await list.json();
    expect(Array.isArray(payload.intakes)).toBe(true);

    const badExtension = await page.request.post("/api/admin/ingest/uploads", {
      data: { catalogId: "20260101_000000", filename: "notes.txt", sizeBytes: 10 },
    });
    expect(badExtension.status()).toBe(400);
  });
});
