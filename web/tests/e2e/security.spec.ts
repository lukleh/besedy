/**
 * API Security Boundary Tests
 *
 * These tests verify that permission boundaries are enforced at the API level,
 * not just hidden in the UI. Critical for ensuring security even if UI is bypassed.
 *
 * Each test logs in as a specific role and attempts an API call that should be forbidden.
 */

import { test, expect } from "./helpers/base-test";
import { loginAs, purgeCatalogAccessByUserId } from "./helpers/auth";
import { TEST_CATALOG_ID, FIRST_RECORDING } from "./helpers/fixtures";

test.describe("API Security Boundaries @security", () => {
  test("LISTENER cannot access transcript API", async ({ page }) => {
    await loginAs(page, "listener");

    // Try to fetch transcript directly via API
    const response = await page.request.get(
      `/api/transcript/${FIRST_RECORDING.hash}?group=${TEST_CATALOG_ID}&backend=faster-whisper/large-v3@silero_vad_v6`
    );

    // Should be forbidden (LISTENER role cannot view transcripts)
    expect(response.status()).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/viewer|transcript|access/i);
  });

  test("LISTENER status filter is ignored (always sees ready only)", async ({ page }) => {
    await loginAs(page, "listener");

    // Request with status=incomplete should be ignored for LISTENER
    const response = await page.request.get(
      `/api/catalog?group=${TEST_CATALOG_ID}&status=incomplete`
    );

    expect(response.status()).toBe(200);
    const body = await response.json();

    // All items should be ready (isActionable=true) regardless of requested filter
    for (const entry of body.entries) {
      expect(entry.isActionable).toBe(true);
    }
  });

  test("LISTENER filter-options excludes status options", async ({ page }) => {
    await loginAs(page, "listener");

    // LISTENER should not get status filter options
    const response = await page.request.get(
      `/api/catalog/filter-options?group=${TEST_CATALOG_ID}`
    );

    expect(response.status()).toBe(200);
    const body = await response.json();

    // Status options should be empty for LISTENER
    expect(body.options.statuses).toHaveLength(0);
  });

  test("VIEWER cannot download audio via API", async ({ page }) => {
    await loginAs(page, "viewer");

    // Try to download audio directly via API with download=true
    const response = await page.request.get(
      `/api/catalogs/${TEST_CATALOG_ID}/recordings/${FIRST_RECORDING.hash}/audio?download=true`
    );

    // Should be forbidden (VIEWER role cannot download)
    expect(response.status()).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/download|permitted/i);
  });

  test("MEMBER cannot edit metadata via API", async ({ page }) => {
    await loginAs(page, "member");

    // Try to PUT metadata directly via API
    const response = await page.request.put(
      `/api/catalogs/${TEST_CATALOG_ID}/recordings/${FIRST_RECORDING.hash}/metadata`,
      {
        data: { title: "Hacked Title" },
      }
    );

    // Should be forbidden (MEMBER role cannot edit metadata)
    expect(response.status()).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/permission|edit|metadata/i);
  });

  test("OWNER cannot grant OWNER level access via API", async ({ page }) => {
    await loginAs(page, "owner");

    // Find any valid target user. Prefer the dedicated 'mutation' user when
    // it is visible in search, but fall back to any returned user (e.g.,
    // 'listener' who has ACTIVE access) if mutation is filtered out due to
    // prior REVOKED state — the test only needs a real userId to exercise
    // the OWNER-grants-OWNER policy check.
    const searchAndPickFirst = async (query: string): Promise<string | null> => {
      const searchResponse = await page.request.get(
        `/api/catalogs/${TEST_CATALOG_ID}/users?search=${encodeURIComponent(query)}`
      );
      expect(searchResponse.status()).toBe(200);
      const body = (await searchResponse.json()) as { users: { id: string }[] };
      return body.users[0]?.id ?? null;
    };

    const targetUserId =
      (await searchAndPickFirst("mutation")) ??
      (await searchAndPickFirst("listener"));
    expect(targetUserId, "expected a searchable target user for OWNER grant test").not.toBeNull();

    // Now try to grant OWNER access
    const response = await page.request.post(
      `/api/catalogs/${TEST_CATALOG_ID}/access`,
      {
        data: {
          userId: targetUserId,
          accessLevel: "OWNER",
        },
      }
    );

    // Should be forbidden (only Admin can grant OWNER access)
    expect(response.status()).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/admin|owner/i);
  });

  test("Admin CAN grant OWNER level access via API", async ({ page }, testInfo) => {
    // Skip on non-primary projects to avoid DB race when granting/revoking access to same user
    test.skip(
      testInfo.project.name !== "Desktop Chrome",
      "Mutation test runs only on Desktop Chrome to avoid parallel DB races"
    );

    await loginAs(page, "admin");

    // First, search for a user to get a real user ID
    // Use 'mutation' user - dedicated for mutation tests to avoid race conditions
    const searchResponse = await page.request.get(
      `/api/catalogs/${TEST_CATALOG_ID}/users?search=mutation`
    );
    expect(searchResponse.status()).toBe(200);

    const searchBody = await searchResponse.json();
    expect(searchBody.users.length).toBeGreaterThan(0);
    const targetUserId = searchBody.users[0].id;

    // Admin should be able to grant OWNER access
    const response = await page.request.post(
      `/api/catalogs/${TEST_CATALOG_ID}/access`,
      {
        data: {
          userId: targetUserId,
          accessLevel: "OWNER",
        },
      }
    );

    // Should succeed - Admin can grant any access level
    expect(response.status()).toBe(201);

    // Clean up - revoke the access we just granted
    const revokeResponse = await page.request.delete(
      `/api/catalogs/${TEST_CATALOG_ID}/access/${targetUserId}`
    );
    expect([200, 204]).toContain(revokeResponse.status());

    // The DELETE endpoint is a soft-revoke, leaving a REVOKED OWNER row
    // behind. Non-admin sibling tests searching for this user would then
    // get zero results (REVOKED OWNER is filtered out for non-admins, and
    // availableUsers excludes any user with a CatalogAccess record). Hard
    // delete the row so the next run starts clean.
    await purgeCatalogAccessByUserId(targetUserId, TEST_CATALOG_ID);
  });
});

test.describe("Unauthenticated API Access @security", () => {
  // These tests verify that APIs require authentication.
  // They use a fresh browser context (no cookies) to make unauthenticated requests.

  test("Unauthenticated request to transcript API returns 401", async ({
    request,
  }) => {
    // Direct API call without any session/cookies
    const response = await request.get(
      `/api/transcript/${FIRST_RECORDING.hash}?group=${TEST_CATALOG_ID}&backend=faster-whisper/large-v3@silero_vad_v6`
    );

    // Unauthenticated requests should return 401.
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.error).toMatch(/authentication required/i);
  });

  test("Unauthenticated request to audio API returns 401", async ({
    request,
  }) => {
    // Direct API call without any session/cookies
    const response = await request.get(
      `/api/catalogs/${TEST_CATALOG_ID}/recordings/${FIRST_RECORDING.hash}/audio`
    );

    // Unauthenticated requests should return 401.
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.error).toMatch(/authentication required/i);
  });

  test("Unauthenticated request to catalog list API returns 401", async ({
    request,
  }) => {
    // Direct API call without any session/cookies
    const response = await request.get(`/api/catalogs`);

    expect(response.status()).toBe(401);
  });
});
