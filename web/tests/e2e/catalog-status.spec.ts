import { test, expect } from "./helpers/base-test";
import { loginAs } from "./helpers/auth";
import { TEST_CATALOG_ID } from "./helpers/fixtures";

test.describe("Catalog Status API", () => {
  test("returns catalog status for authorized user", async ({ page }) => {
    await loginAs(page, "viewer");

    const response = await page.request.get(
      `/api/catalogs/${TEST_CATALOG_ID}/status`
    );

    expect(response.status()).toBe(200);
    const body = await response.json();

    expect(body).toHaveProperty("catalogId", TEST_CATALOG_ID);
    expect(body).toHaveProperty("lastModifiedAt");
    expect(body).toHaveProperty("curatedEntries");
    expect(typeof body.curatedEntries).toBe("number");
  });

  test("returns 403 for unauthorized user", async ({ page }) => {
    await loginAs(page, "noaccess");

    const response = await page.request.get(
      `/api/catalogs/${TEST_CATALOG_ID}/status`
    );

    expect(response.status()).toBe(403);
  });

  test("returns error for non-existent catalog", async ({ page }) => {
    await loginAs(page, "viewer");

    // Use a valid timestamp format that doesn't exist
    const response = await page.request.get(
      `/api/catalogs/19991231_235959/status`
    );

    // Should return 404 (not found) or 403 (forbidden - user has no access)
    expect([403, 404]).toContain(response.status());
  });
});
