/**
 * Metadata Audit Logging E2E Tests
 *
 * Verifies that METADATA_UPDATED and METADATA_VERIFIED audit events are logged
 * when users edit catalog metadata.
 */

import { test, expect } from "./helpers/base-test";
import { devLogin } from "./helpers/auth";
import { URLS, FIRST_RECORDING, TEST_CATALOG_ID } from "./helpers/fixtures";
import { waitForPageReady } from "./helpers/navigation";

test.describe("Metadata Audit Logging", () => {
  test("METADATA_UPDATED: logged when editor saves metadata changes", async ({
    page,
  }, testInfo) => {
    // Only run on primary project to avoid DB race conditions
    test.skip(
      testInfo.project.name !== "Desktop Chrome",
      "Mutation test runs only on Desktop Chrome to avoid parallel DB races"
    );

    // Step 1: Login as editor and edit metadata
    await devLogin(page, "editor");
    await page.goto(URLS.recordingEdit(FIRST_RECORDING.hash));
    await waitForPageReady(page);

    // Find the notes field and add unique content
    const notesField = page.getByPlaceholder(/notes about this recording/i);
    await expect(notesField).toBeVisible({ timeout: 10000 });

    const testNote = `Audit test ${Date.now()}`;
    await notesField.fill(testNote);

    // Save changes
    const saveButton = page.getByRole("button", { name: /save/i });
    await saveButton.click();
    await expect(page.getByText("Metadata saved")).toBeVisible({ timeout: 5000 });

    // Step 2: Login as superadmin to check audit log via API
    await devLogin(page, "superadmin");

    // Query audit API for METADATA_UPDATED entries
    const response = await page.request.get(
      `/api/admin/audit?action=METADATA_UPDATED&limit=10`
    );
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.logs).toBeDefined();
    expect(body.logs.length).toBeGreaterThan(0);

    // Find the audit entry for our recording
    const auditEntry = body.logs.find(
      (entry: { resourceId: string; action: string }) =>
        entry.resourceId === FIRST_RECORDING.hash &&
        entry.action === "METADATA_UPDATED"
    );
    expect(auditEntry).toBeDefined();

    // Verify audit entry has expected structure
    expect(auditEntry.resource).toBe("metadata");
    expect(auditEntry.details).toBeDefined();
    expect(auditEntry.details.groupId).toBe(TEST_CATALOG_ID);
    expect(auditEntry.details.changedFields).toContain("notes");
  });

  test("METADATA_VERIFIED: logged when editor toggles verification", async ({
    page,
  }, testInfo) => {
    // Only run on primary project to avoid DB race conditions
    test.skip(
      testInfo.project.name !== "Desktop Chrome",
      "Mutation test runs only on Desktop Chrome to avoid parallel DB races"
    );

    // Step 1: Login as editor and toggle verification
    await devLogin(page, "editor");
    await page.goto(URLS.recordingEdit(FIRST_RECORDING.hash));
    await waitForPageReady(page);

    // Get current verified state and toggle it
    const verifiedCheckbox = page.getByRole("checkbox", { name: /verified/i });
    await expect(verifiedCheckbox).toBeVisible({ timeout: 10000 });

    const wasChecked = await verifiedCheckbox.isChecked();

    // Toggle the checkbox
    await verifiedCheckbox.click();

    // Save changes
    const saveButton = page.getByRole("button", { name: /save/i });
    await saveButton.click();
    await expect(page.getByText("Metadata saved")).toBeVisible({ timeout: 5000 });

    // Step 2: Login as superadmin to check audit log via API
    await devLogin(page, "superadmin");

    // Query audit API for METADATA_VERIFIED entries
    const response = await page.request.get(
      `/api/admin/audit?action=METADATA_VERIFIED&limit=10`
    );
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.logs).toBeDefined();
    expect(body.logs.length).toBeGreaterThan(0);

    // Find the audit entry for our recording
    const auditEntry = body.logs.find(
      (entry: { resourceId: string; action: string }) =>
        entry.resourceId === FIRST_RECORDING.hash &&
        entry.action === "METADATA_VERIFIED"
    );
    expect(auditEntry).toBeDefined();

    // Verify audit entry has expected structure
    expect(auditEntry.resource).toBe("metadata");
    expect(auditEntry.details).toBeDefined();
    expect(auditEntry.details.groupId).toBe(TEST_CATALOG_ID);
    expect(auditEntry.details.verified).toBe(!wasChecked);

    // Cleanup: restore original verified state
    await devLogin(page, "editor");
    await page.goto(URLS.recordingEdit(FIRST_RECORDING.hash));
    await waitForPageReady(page);
    const checkbox = page.getByRole("checkbox", { name: /verified/i });
    await expect(checkbox).toBeVisible({ timeout: 10000 });
    const currentState = await checkbox.isChecked();
    if (currentState !== wasChecked) {
      await checkbox.click();
      await page.getByRole("button", { name: /save/i }).click();
      await expect(page.getByText("Metadata saved")).toBeVisible({ timeout: 5000 });
    }
  });

  test("Both actions logged when editing metadata AND toggling verification", async ({
    page,
  }, testInfo) => {
    // Only run on primary project to avoid DB race conditions
    test.skip(
      testInfo.project.name !== "Desktop Chrome",
      "Mutation test runs only on Desktop Chrome to avoid parallel DB races"
    );

    // Capture timestamp before changes
    const beforeTimestamp = new Date().toISOString();

    // Step 1: Login as editor and make both changes
    await devLogin(page, "editor");
    await page.goto(URLS.recordingEdit(FIRST_RECORDING.hash));
    await waitForPageReady(page);

    // Get current verified state
    const verifiedCheckbox = page.getByRole("checkbox", { name: /verified/i });
    await expect(verifiedCheckbox).toBeVisible({ timeout: 10000 });
    const wasChecked = await verifiedCheckbox.isChecked();

    // Edit notes field
    const notesField = page.getByPlaceholder(/notes about this recording/i);
    await expect(notesField).toBeVisible({ timeout: 10000 });
    const testNote = `Combined audit test ${Date.now()}`;
    await notesField.fill(testNote);

    // Toggle verification
    await verifiedCheckbox.click();

    // Save - both changes in one request
    const saveButton = page.getByRole("button", { name: /save/i });
    await saveButton.click();
    await expect(page.getByText("Metadata saved")).toBeVisible({ timeout: 5000 });

    // Step 2: Login as superadmin to check audit log via API
    await devLogin(page, "superadmin");

    // Query for both action types since our change
    const [updatedResponse, verifiedResponse] = await Promise.all([
      page.request.get(
        `/api/admin/audit?action=METADATA_UPDATED&from=${beforeTimestamp}&limit=10`
      ),
      page.request.get(
        `/api/admin/audit?action=METADATA_VERIFIED&from=${beforeTimestamp}&limit=10`
      ),
    ]);

    expect(updatedResponse.status()).toBe(200);
    expect(verifiedResponse.status()).toBe(200);

    const updatedBody = await updatedResponse.json();
    const verifiedBody = await verifiedResponse.json();

    // Both should have entries for our recording
    const updatedEntry = updatedBody.logs.find(
      (entry: { resourceId: string }) =>
        entry.resourceId === FIRST_RECORDING.hash
    );
    const verifiedEntry = verifiedBody.logs.find(
      (entry: { resourceId: string }) =>
        entry.resourceId === FIRST_RECORDING.hash
    );

    expect(updatedEntry).toBeDefined();
    expect(verifiedEntry).toBeDefined();

    // Cleanup: restore original verified state
    await devLogin(page, "editor");
    await page.goto(URLS.recordingEdit(FIRST_RECORDING.hash));
    await waitForPageReady(page);
    const checkbox = page.getByRole("checkbox", { name: /verified/i });
    await expect(checkbox).toBeVisible({ timeout: 10000 });
    const currentState = await checkbox.isChecked();
    if (currentState !== wasChecked) {
      await checkbox.click();
      await page.getByRole("button", { name: /save/i }).click();
      await expect(page.getByText("Metadata saved")).toBeVisible({ timeout: 5000 });
    }
  });
});
