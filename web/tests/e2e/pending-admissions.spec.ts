/**
 * Pending admission system E2E tests.
 *
 * Tests the pending-admission flow for adding new users to the allowlist.
 * These tests focus on admission API and admin UI behavior.
 */

import { test, expect } from "./helpers/base-test";
import { loginAs } from "./helpers/auth";
import { URLS, TEST_CATALOG_ID } from "./helpers/fixtures";
import { waitForPageReady } from "./helpers/navigation";
import {
  createPendingAdmission,
  deletePendingAdmission,
  listPendingAdmissions,
} from "./helpers/pending-admissions";

test.describe("Pending Admission Management", () => {
  // Helper to generate unique email for each test execution
  // Using Date.now() + random suffix to avoid conflicts across parallel browsers
  const uniqueEmail = (suffix: string) =>
    `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${suffix}@example.com`;

  test.describe("Admin API", () => {
    test("admin can create pending admission without catalog access", async ({
      page,
    }) => {
      // Login as admin to get auth cookies
      await loginAs(page, "admin");

      // Create pending admission without catalog access (use page.request to share cookies)
      const email = uniqueEmail("basic");
      const admission = await createPendingAdmission(page.request, { email });

      expect(admission.id).toBeDefined();
      expect(admission.email).toBe(email);
      expect(admission.status).toBe("PENDING");
      expect(admission.catalogAccess).toBeNull();
    });

    test("admin can create pending admission with catalog access", async ({
      page,
    }) => {
      await loginAs(page, "admin");

      const email = uniqueEmail("with-access");
      const admission = await createPendingAdmission(page.request, {
        email,
        catalogId: TEST_CATALOG_ID,
        accessLevel: "VIEWER",
      });

      expect(admission.id).toBeDefined();
      expect(admission.email).toBe(email);
      expect(admission.catalogAccess?.catalogId).toBe(TEST_CATALOG_ID);
      expect(admission.catalogAccess?.accessLevel).toBe("VIEWER");
    });

    test("admin can list pending admissions", async ({ page }) => {
      await loginAs(page, "admin");

      // Create a test pending admission
      const email = uniqueEmail("list");
      await createPendingAdmission(page.request, { email });

      // List pending admissions
      const admissions = await listPendingAdmissions(page.request);

      // Should include our new pending admission
      const found = admissions.find((admission) => admission.email === email);
      expect(found).toBeDefined();
      expect(found?.status).toBe("PENDING");
    });

    test("admin can revoke pending admission", async ({ page }) => {
      await loginAs(page, "admin");

      // Create pending admission
      const email = uniqueEmail("revoke");
      const admission = await createPendingAdmission(page.request, { email });

      // Revoke it
      await deletePendingAdmission(page.request, admission.id);

      // Should not be in the list anymore
      const admissions = await listPendingAdmissions(page.request);
      const found = admissions.find((pendingAdmission) => pendingAdmission.email === email);
      expect(found).toBeUndefined();
    });

    test("duplicate pending admission request is idempotent", async ({ page }) => {
      await loginAs(page, "admin");

      const email = uniqueEmail("duplicate");

      // First request creates the PENDING admission.
      const first = await createPendingAdmission(page.request, { email });
      expect(first.status).toBe("PENDING");

      // A second request for the same email is treated as an update (the
      // admin-portal-admission-create flow only 409s on CLAIMED admissions
      // or existing users). Verify it succeeds and leaves exactly one row.
      const second = await createPendingAdmission(page.request, { email });
      expect(second.status).toBe("PENDING");

      const admissions = await listPendingAdmissions(page.request);
      const matches = admissions.filter((admission) => admission.email === email);
      expect(matches).toHaveLength(1);
    });

    test("non-admin cannot create pending admission", async ({ page }) => {
      // Login as regular user (owner has catalog access but not admin)
      await loginAs(page, "owner");

      const email = uniqueEmail("unauthorized");

      // Try to create pending admission - should fail
      const response = await page.request.post("/api/admin/portal-admissions", {
        data: { email },
      });

      expect(response.status()).toBe(403);
    });
  });

  test.describe("Admin UI", () => {
    test("admin can view pending admissions page", async ({ page }) => {
      await loginAs(page, "admin");
      await page.goto(URLS.adminPendingAdmissions);
      await waitForPageReady(page);

      // Page title visible (pending admissions are managed on the Users page)
      await expect(
        page.getByRole("heading", { name: "Users", level: 1 })
      ).toBeVisible({ timeout: 10000 });

      // Table visible
      await expect(page.locator("table")).toBeVisible({ timeout: 5000 });
    });

    test("admin can open add user dialog", async ({ page }) => {
      await loginAs(page, "admin");
      await page.goto(URLS.adminPendingAdmissions);
      await waitForPageReady(page);

      // Click add user button (use keyboard to bypass sticky header on mobile)
      const addButton = page.getByRole("button", { name: /add user/i });
      await expect(addButton).toBeVisible({ timeout: 10000 });
      await addButton.focus();
      await page.keyboard.press("Enter");

      // Dialog opens
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });

      // Email input visible
      const emailInput = dialog.locator('input[type="email"]');
      await expect(emailInput).toBeVisible({ timeout: 5000 });
    });

    test("admin can create pending admission via UI", async ({ page }) => {
      await loginAs(page, "admin");
      await page.goto(URLS.adminPendingAdmissions);
      await waitForPageReady(page);

      // Open dialog (use keyboard to bypass sticky header on mobile)
      const addButton = page.getByRole("button", { name: /add user/i });
      await addButton.focus();
      await page.keyboard.press("Enter");

      // Scope the dialog locator to the specific Add User dialog by its
      // accessible title. A raw `[role="dialog"]` match can collide with
      // other Radix/Vaul overlays on mobile (toasts, drawers) that keep an
      // element in the DOM after close.
      const dialog = page.getByRole("dialog", { name: /add user/i });
      await expect(dialog).toBeVisible({ timeout: 5000 });

      // Fill email
      const email = uniqueEmail("ui");
      const emailInput = dialog.locator('input[type="email"]');
      await emailInput.fill(email);

      // Submit - use type="submit" to find the correct button
      // (There might be multiple "Add User" buttons on the page)
      const submitButton = dialog.locator('button[type="submit"]');
      await expect(submitButton).toBeVisible({ timeout: 5000 });
      await expect(submitButton).toBeEnabled({ timeout: 5000 });
      await submitButton.click();

      // Wait for dialog to close (indicates success)
      await expect(dialog).toBeHidden({ timeout: 10000 });

      // Refresh and verify pending admission appears in table
      await page.reload();
      await waitForPageReady(page);

      // Filter by "Pending" status to see pending admissions
      // (Default view shows users; pending admissions show under the Pending filter)
      // On desktop ResponsiveSelect renders a role=combobox trigger; on mobile
      // it renders a plain button that opens a drawer. Match either.
      const statusFilter = page
        .getByRole("combobox", { name: /filter by status/i })
        .or(page.getByRole("button", { name: /filter by status/i }))
        .filter({ visible: true })
        .first();
      await statusFilter.click();

      // Wait for the Pending option to appear. Desktop uses role=listbox/
      // option; mobile renders buttons inside a drawer. Accept either.
      const pendingOption = page
        .locator('[role="listbox"] [role="option"]', { hasText: /^Pending$/ })
        .or(page.getByRole("button", { name: /^Pending$/ }))
        .filter({ visible: true })
        .first();
      await expect(pendingOption).toBeVisible({ timeout: 5000 });
      // On narrow viewports the drawer can render the Pending button below
      // the fold; scroll it into view before clicking.
      await pendingOption.scrollIntoViewIfNeeded();
      await pendingOption.click({ force: true });

      // Wait for table to update and verify pending admission appears
      await expect(page.getByText(email)).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe("Catalog pending grant (owner flow)", () => {
    test("owner can open grant access dialog", async ({ page }) => {
      await loginAs(page, "owner");

      // Navigate to catalog settings
      await page.goto(URLS.catalogSettings);
      await waitForPageReady(page);

      // Click grant access button
      const grantButton = page.getByRole("button", { name: /grant access/i });
      await expect(grantButton).toBeVisible({ timeout: 10000 });
      await grantButton.click();

      // Dialog opens
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });

      // User search combobox is visible
      const userSearch = dialog.getByRole("combobox").first();
      await expect(userSearch).toBeVisible({ timeout: 5000 });
    });

    test("owner can add a pending grant via the catalog API", async ({ page }) => {
      await loginAs(page, "owner");

      const email = uniqueEmail("owner-pending-grant");

      // Use the dedicated pending-grant API (which creates pending grant or direct access)
      const response = await page.request.post(
        `/api/catalogs/${TEST_CATALOG_ID}/pending-catalog-grants`,
        {
          data: {
            email,
            accessLevel: "VIEWER",
          },
        }
      );

      expect(response.ok()).toBeTruthy();
      const result = await response.json();
      expect(result.email).toBe(email);
      expect(result.accessLevel).toBe("VIEWER");
      // For new users, this creates pending first-login state.
      expect(result.userStatus).toBe("PENDING");
    });
  });
});
