/**
 * Shared authentication helpers for E2E tests
 *
 * Provides reusable login functions for all test user roles.
 * Test users are seeded by prisma/seed-test.ts.
 *
 * Auth sessions are created directly from tests (DB row + signed cookie),
 * so E2E does not rely on runtime mock-auth endpoints.
 */

import { Page, expect } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { TEST_CATALOG_ID, TEST_EVENTS } from "../../../prisma/test-data";

export type UserRole =
  | "superadmin"
  | "admin"
  | "owner"
  | "editor"
  | "member"
  | "viewer"
  | "listener"
  | "noaccess"
  | "pending"
  | "blocked";

type NotificationSeedRole = "superadmin" | "admin";

/**
 * Email addresses for each test user role
 */
export const ROLE_EMAILS: Record<UserRole, string> = {
  superadmin: "superadmin@besedy.test",
  admin: "admin@besedy.test",
  owner: "owner@besedy.test",
  editor: "editor@besedy.test",
  member: "member@besedy.test",
  viewer: "viewer@besedy.test",
  listener: "listener@besedy.test",
  noaccess: "noaccess@besedy.test",
  pending: "pending@besedy.test",
  blocked: "blocked@besedy.test",
};

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3002";
const BASE_URL_OBJECT = new URL(BASE_URL);
const DATABASE_URL =
  process.env.PLAYWRIGHT_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://besedy_test:besedy_test@localhost:5434/besedy_test";
const AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-for-e2e-tests-32bytes";
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 180;

const pool = new Pool({
  connectionString: DATABASE_URL,
});

function signSessionToken(token: string): string {
  const signature = createHmac("sha256", AUTH_SECRET).update(token).digest("base64");
  return `${token}.${signature}`;
}

async function issueSessionForEmail(page: Page, email: string): Promise<void> {
  const userResult = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE email = $1 LIMIT 1",
    [email]
  );
  if (userResult.rowCount !== 1) {
    throw new Error(`User not found for test login: ${email}`);
  }

  const userId = userResult.rows[0].id;
  const token = randomUUID();
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_EXPIRES_IN_SECONDS * 1000);

  await pool.query(
    `INSERT INTO sessions (id, token, user_id, expires_at, ip_address, user_agent, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
    [sessionId, token, userId, expiresAt.toISOString(), "127.0.0.1", "playwright-e2e"]
  );

  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: "besedy.session_token",
      value: signSessionToken(token),
      domain: BASE_URL_OBJECT.hostname,
      path: "/",
      httpOnly: true,
      secure: BASE_URL_OBJECT.protocol === "https:",
      sameSite: "Lax",
      expires: Math.floor(expiresAt.getTime() / 1000),
    },
  ]);
}

async function getUserIdByEmail(email: string): Promise<string> {
  const userResult = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE email = $1 LIMIT 1",
    [email]
  );
  if (userResult.rowCount !== 1) {
    throw new Error(`User not found for test login: ${email}`);
  }
  return userResult.rows[0].id;
}

/**
 * Hard-delete a user's catalog access row. The public DELETE endpoint is a
 * soft-revoke (keeps the row with status=REVOKED), which is correct for UX
 * but leaks state between parallel projects: a user left with a REVOKED
 * OWNER row is filtered out of subsequent user-search results for non-admin
 * callers. Tests that grant-and-revoke during a run should purge the row
 * afterwards so siblings see a clean slate.
 */
export async function purgeCatalogAccessByUserId(
  userId: string,
  catalogId: string
): Promise<void> {
  await pool.query(
    "DELETE FROM catalog_access WHERE user_id = $1 AND catalog_id = $2",
    [userId, catalogId]
  );
}

/**
 * Delete every event notification for a role in the test catalog. Publishing
 * events fan out notifications to all catalog-access users, so tests that
 * expect the empty-state UI must scrub the target user before asserting.
 */
export async function clearEventNotificationsForRole(role: UserRole): Promise<void> {
  const email = ROLE_EMAILS[role];
  const userId = await getUserIdByEmail(email);
  await pool.query(
    "DELETE FROM event_notifications WHERE user_id = $1 AND catalog_id = $2",
    [userId, TEST_CATALOG_ID]
  );
}

/**
 * Reset a catalog event row back to the unreleased state with no primary
 * recording. Useful for mutation tests that toggle release state and would
 * otherwise leave the row in a state that breaks subsequent runs.
 */
export async function resetEventReleaseState(
  catalogId: string,
  eventTitle: string
): Promise<void> {
  await pool.query(
    `UPDATE catalog_event
     SET released = false,
         published_notified_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE workflow_group_id = $1
       AND title = $2`,
    [catalogId, eventTitle]
  );
  await pool.query(
    `UPDATE catalog_event_recording
     SET is_primary = false
     WHERE workflow_group_id = $1
       AND event_id IN (
         SELECT id FROM catalog_event
         WHERE workflow_group_id = $1 AND title = $2
       )`,
    [catalogId, eventTitle]
  );
}

/**
 * Reset seeded notifications for a role to a deterministic state.
 * This keeps notification E2E tests stable when tests mutate read/unread state.
 */
export async function resetSeededNotifications(role: NotificationSeedRole): Promise<void> {
  const email = ROLE_EMAILS[role];
  const userId = await getUserIdByEmail(email);

  await pool.query(
    "DELETE FROM event_notifications WHERE user_id = $1 AND catalog_id = $2",
    [userId, TEST_CATALOG_ID]
  );

  const eventTitles = [TEST_EVENTS[0].title, TEST_EVENTS[2].title];
  const eventResult = await pool.query<{ id: number; title: string }>(
    `SELECT id, title
     FROM catalog_event
     WHERE workflow_group_id = $1
       AND title = ANY($2::text[])`,
    [TEST_CATALOG_ID, eventTitles]
  );
  const eventIdByTitle = new Map(eventResult.rows.map((row) => [row.title, row.id]));
  const firstReleasedEventId = eventIdByTitle.get(TEST_EVENTS[0].title);
  const secondReleasedEventId = eventIdByTitle.get(TEST_EVENTS[2].title);
  if (!firstReleasedEventId || !secondReleasedEventId) {
    throw new Error("Released events missing for notification reset");
  }

  const now = Date.now();
  const seedRows = [
    {
      eventId: firstReleasedEventId,
      title: TEST_EVENTS[0].title,
      isRead: false,
      createdAt: new Date(now - 1000 * 60 * 5),
    },
    {
      eventId: secondReleasedEventId,
      title: TEST_EVENTS[2].title,
      isRead: false,
      createdAt: new Date(now - 1000 * 60 * 10),
    },
  ];

  for (const row of seedRows) {
    await pool.query(
      `INSERT INTO event_notifications (
        id, user_id, catalog_id, event_id, title, is_read, read_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        userId,
        TEST_CATALOG_ID,
        row.eventId,
        row.title,
        row.isRead,
        null,
        row.createdAt,
      ]
    );
  }
}

/**
 * Expected redirect patterns after session bootstrap.
 * Patterns are permissive to match both intermediate (/catalog) and final
 * (/catalog/:id) URLs.
 */
const ROLE_REDIRECT_PATTERNS: Record<UserRole, RegExp> = {
  superadmin: /\/(admin|catalog)/,
  admin: /\/(admin|catalog)/,
  owner: /\/catalog/,
  editor: /\/catalog/,
  member: /\/catalog/,
  viewer: /\/catalog/,
  listener: /\/catalog/,
  noaccess: /\/auth\/no-access/,
  pending: /\/auth\/signin/,
  blocked: /\/auth\/signin/,
};

/**
 * Log in as a specific user role using direct test session bootstrap.
 *
 * @param page - Playwright page object
 * @param role - The user role to log in as
 */
export async function loginAs(page: Page, role: UserRole): Promise<void> {
  const email = ROLE_EMAILS[role];
  const expectedUrl = ROLE_REDIRECT_PATTERNS[role];

  await issueSessionForEmail(page, email);
  await page.goto("/catalog", { timeout: 30000, waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(expectedUrl, { timeout: 15000 });

  // Allow any follow-up redirects (e.g., /catalog -> /catalog/:id) to settle
  const currentUrl = page.url();
  if (currentUrl.endsWith("/catalog")) {
    await page.waitForURL(/\/catalog\/[^/]+/, { timeout: 10000 }).catch(() => {});
  }
  await page.waitForLoadState("networkidle").catch(() => {});
}

/**
 * Create an authenticated session for API-focused tests without UI navigation.
 *
 * @param page - Playwright page object (used for request context)
 * @param role - The user role to log in as
 */
export async function devLogin(page: Page, role: UserRole): Promise<void> {
  const email = ROLE_EMAILS[role];
  await issueSessionForEmail(page, email);
}

/**
 * Log in as superadmin (full system access)
 */
export async function loginAsSuperadmin(page: Page): Promise<void> {
  await loginAs(page, "superadmin");
}

/**
 * Log in as admin (user/catalog management, no superadmin powers)
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  await loginAs(page, "admin");
}

/**
 * Log in as catalog owner (OWNER access on test catalog)
 */
export async function loginAsOwner(page: Page): Promise<void> {
  await loginAs(page, "owner");
}

/**
 * Log in as catalog editor (EDITOR access on test catalog)
 */
export async function loginAsEditor(page: Page): Promise<void> {
  await loginAs(page, "editor");
}

/**
 * Log in as catalog member (MEMBER access on test catalog)
 */
export async function loginAsMember(page: Page): Promise<void> {
  await loginAs(page, "member");
}

/**
 * Log in as catalog viewer (VIEWER access on test catalog)
 */
export async function loginAsViewer(page: Page): Promise<void> {
  await loginAs(page, "viewer");
}

/**
 * Log in as catalog listener (LISTENER access on test catalog - no transcripts)
 */
export async function loginAsListener(page: Page): Promise<void> {
  await loginAs(page, "listener");
}

/**
 * Log in as no-access user (no catalog access)
 */
export async function loginAsNoAccess(page: Page): Promise<void> {
  await loginAs(page, "noaccess");
}

/**
 * Clear cookies and navigate to a neutral state.
 * This avoids race conditions where clearing cookies on a protected page
 * triggers a proxy redirect that conflicts with subsequent navigation.
 */
export async function clearSessionSafely(page: Page): Promise<void> {
  // Wait for any pending navigations to complete
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  // Navigate to signin first (public route, no redirect)
  await page.goto("/auth/signin", { timeout: 30000, waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/auth\/signin/, { timeout: 10000 });
  // Now safe to clear cookies
  await page.context().clearCookies();
}

/**
 * Log out the current user
 */
export async function logout(page: Page): Promise<void> {
  // Find and click the user menu button using exact aria-label match
  const userMenu = page.getByRole("button", { name: "User menu" });

  // Wait for user menu to be visible with reasonable timeout
  await expect(userMenu).toBeVisible({ timeout: 5000 });
  await userMenu.click();

  // Wait for dropdown/drawer to appear and click sign out.
  // Desktop renders role=menuitem inside a DropdownMenu; mobile renders a
  // plain role=button inside a Drawer dialog. Match either and click the
  // one that is actually visible.
  const signOutOption = page
    .getByRole("menuitem", { name: /sign out/i })
    .or(page.getByRole("button", { name: /sign out/i }))
    .filter({ visible: true });
  await expect(signOutOption).toBeVisible({ timeout: 5000 });
  await signOutOption.click();

  // Wait for redirect to sign-in page
  // Use try-catch to handle potential navigation interruption (ERR_ABORTED)
  // This can happen when multiple redirects occur rapidly during sign out
  try {
    await page.waitForURL(/\/auth\/signin/, { timeout: 10000 });
  } catch {
    // Retry waiting if first attempt was interrupted
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForURL(/\/auth\/signin/, { timeout: 5000 });
  }
}

/**
 * Assert that the user is redirected to the sign-in page
 */
export async function expectRedirectToSignIn(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/auth\/signin/);
}

/**
 * Assert that an access denied message is shown
 */
export async function expectAccessDenied(page: Page): Promise<void> {
  // Check for common access denied patterns
  const accessDenied = page.locator("text=/access denied|not authorized|permission denied|forbidden/i");
  const isVisible = await accessDenied.isVisible().catch(() => false);

  if (!isVisible) {
    // May redirect to signin or show 403
    const url = page.url();
    const is403OrSignin = url.includes("/auth/signin") || url.includes("403");
    expect(is403OrSignin || isVisible).toBe(true);
  }
}

/**
 * Navigate to a protected page and expect to be redirected to sign-in
 */
export async function expectProtectedRoute(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expectRedirectToSignIn(page);
}
