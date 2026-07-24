/**
 * Authentication E2E tests.
 *
 * Verifies the essential authentication flows work correctly.
 * Edge cases (OAuth errors, specific error messages) belong in unit tests.
 */

import { test, expect } from "./helpers/base-test";
import { loginAs, logout, devLogin } from "./helpers/auth";
import { URLS } from "./helpers/fixtures";
import { waitForPageReady } from "./helpers/navigation";

test.describe("Authentication", () => {
  test("sign in page shows login options", async ({ page }) => {
    await page.goto(URLS.signIn);
    await waitForPageReady(page);

    // Sign in button visible
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible({ timeout: 10000 });
  });

  test("user can sign in and reach catalog", async ({ page }) => {
    // Use superadmin (direct user with pre-created account) to avoid race conditions
    // when multiple browsers run this test in parallel. Each browser would otherwise
    // race to claim the same seeded pending admission for users like 'owner'.
    await loginAs(page, "superadmin");

    // Redirected to catalog or admin (superadmin can access both)
    await expect(page).toHaveURL(/\/(catalog|admin)\//);

    // Main content visible
    await expect(page.locator("main")).toBeVisible();
  });

  test("user can sign out", async ({ page }) => {
    // Use admin (direct user with pre-created account) to avoid race conditions
    await loginAs(page, "admin");
    await logout(page);

    // Redirected to sign in
    await expect(page).toHaveURL(/\/auth\/signin/);
  });

  test("protected routes require authentication", async ({ page }) => {
    // Try to access catalog without signing in
    await page.goto(URLS.catalog);
    await waitForPageReady(page);

    // Redirected to sign in
    await expect(page).toHaveURL(/\/auth\/signin/);
  });

  test("pending user is treated as signed out", async ({ page }) => {
    await loginAs(page, "pending");

    // Pending users are treated as unauthenticated and routed to sign-in.
    await expect(page).toHaveURL(/\/auth\/signin/);
  });
});

test.describe("Session Bootstrap (API Testing)", () => {
  test("devLogin creates valid session for API calls", async ({ page }) => {
    await devLogin(page, "admin");

    // Session cookies are automatically set - verify by calling protected API
    const response = await page.request.get("/api/catalogs");
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("devLogin works for different user roles", async ({ page }) => {
    // Test with viewer role
    await devLogin(page, "viewer");

    // Can access catalogs API
    const response = await page.request.get("/api/catalogs");
    expect(response.ok()).toBe(true);
  });

  test("devLogin session allows page navigation", async ({ page }) => {
    await devLogin(page, "owner");

    // Navigate to catalog page - should work without sign-in redirect
    await page.goto(URLS.catalog);
    await waitForPageReady(page);

    // Should be on catalog page, not redirected to signin
    await expect(page).toHaveURL(/\/catalog/);
    await expect(page.locator("main")).toBeVisible();
  });

  test("pending user session is treated as signed-out on API", async ({ page }) => {
    await devLogin(page, "pending");
    const response = await page.request.get("/api/catalogs");
    expect(response.status()).toBe(401);
  });

  test("blocked user session is treated as signed-out on API", async ({ page }) => {
    await devLogin(page, "blocked");
    const response = await page.request.get("/api/catalogs");
    expect(response.status()).toBe(401);
  });
});
