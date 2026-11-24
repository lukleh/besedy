/**
 * The admin corrections overview: who can reach the page and its API.
 *
 * The page names people and what each has done, so it is for administrators.
 * Administering the catalog does not open it. What the page shows once
 * correction is under way is covered in correction.spec.ts.
 *
 * @tags @smoke
 */

import { test, expect } from "./helpers/base-test";
import { loginAs } from "./helpers/auth";
import { waitForPageReady } from "./helpers/navigation";

test.describe("Admin Corrections @smoke", () => {
  test("admin can open the corrections overview from the admin area", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/corrections");
    await waitForPageReady(page);

    await expect(page).toHaveURL(/\/admin\/corrections/);
    await expect(page.getByTestId("correction-admin-summary")).toBeVisible({ timeout: 20000 });
    await expect(page.locator('a[href="/admin/corrections"]').first()).toBeAttached();
  });

  test("a catalog admin is redirected away from the corrections overview", async ({ page }) => {
    await loginAs(page, "catalog_admin");
    await page.goto("/admin/corrections");
    await waitForPageReady(page);

    await expect(page).not.toHaveURL(/\/admin\/corrections/);
    await expect(page.getByTestId("correction-admin-summary")).toHaveCount(0);
  });

  test("corrections overview API is admin-only", async ({ page }) => {
    await loginAs(page, "catalog_admin");
    expect((await page.request.get("/api/admin/corrections")).status()).toBe(403);

    await loginAs(page, "admin");
    const response = await page.request.get("/api/admin/corrections");
    expect(response.ok()).toBe(true);
    expect(Array.isArray((await response.json()).people)).toBe(true);
  });
});
