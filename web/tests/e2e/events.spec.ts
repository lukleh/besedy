/**
 * Event catalog E2E tests.
 *
 * Covers admin events UI, access gating, and core mutation workflows.
 */

import { test, expect } from "./helpers/base-test";
import type { APIRequestContext } from "@playwright/test";
import { loginAs, devLogin, resetEventReleaseState } from "./helpers/auth";
import { TEST_AUDIO_FILES, TEST_EVENTS, TEST_CATALOG_ID, URLS } from "./helpers/fixtures";
import { waitForPageReady } from "./helpers/navigation";

interface EventListItem {
  id: number;
  title: string | null;
}

async function setLabsEnabled(request: APIRequestContext, enabled: boolean): Promise<void> {
  const response = await request.put("/api/preferences/labs", {
    data: { enabled },
  });
  expect(response.ok()).toBeTruthy();
}

async function getEventIdByTitle(
  request: APIRequestContext,
  title: string
): Promise<number> {
  const params = new URLSearchParams({
    group: TEST_CATALOG_ID,
    search: title,
    limit: "50",
  });
  const response = await request.get(`/api/catalog-events?${params.toString()}`);
  expect(response.ok()).toBeTruthy();

  const body = (await response.json()) as { events: EventListItem[] };
  const event = body.events.find((item) => item.title === title);
  if (!event) {
    throw new Error(`Seeded event not found by title: ${title}`);
  }
  return event.id;
}

test.describe("Event Catalog", () => {
  test.describe.configure({ mode: "serial" });

  test("admin with Labs sees Events tab and viewer without Labs does not", async ({ page }) => {
    await loginAs(page, "admin");
    await setLabsEnabled(page.request, true);
    await page.goto(URLS.catalog);
    await waitForPageReady(page);

    await expect(page.getByRole("tab", { name: "Events" })).toBeVisible({ timeout: 10000 });

    await loginAs(page, "viewer");
    await setLabsEnabled(page.request, false);
    await page.goto(URLS.catalog);
    await waitForPageReady(page);

    await expect(page.getByRole("tab", { name: "Events" })).toHaveCount(0);
  });

  test("viewer lands on events view but cannot create events", async ({ page }) => {
    // With events rolled out publicly, viewers default to the events view
    // without a tab switcher (tabs require canEdit). Verify the events list
    // loads and the Create Event control is absent.
    await loginAs(page, "viewer");
    await setLabsEnabled(page.request, true);
    await page.goto(URLS.catalog);
    await waitForPageReady(page);

    await expect(page.getByText(/\d+ events/i).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "Create Event" })).toHaveCount(0);
  });

  test("editor lands on events view but cannot create events", async ({ page }) => {
    // Editors have browse rights but no event-edit rights (OWNER/admin only),
    // so they see the events view directly with no Create Event button.
    await loginAs(page, "editor");
    await setLabsEnabled(page.request, true);
    await page.goto(URLS.catalog);
    await waitForPageReady(page);

    await expect(page.getByText(/\d+ events/i).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "Create Event" })).toHaveCount(0);
  });

  test("events tab lists seeded events", async ({ page }) => {
    await loginAs(page, "admin");
    await setLabsEnabled(page.request, true);
    await page.goto(URLS.catalogEvents);
    await waitForPageReady(page);

    await expect(page.getByRole("tab", { name: "Events" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(page.getByRole("button", { name: "Create Event" })).toBeVisible({
      timeout: 10000,
    });
    // The events list identifies events by date + location; titles are not
    // rendered in the list. The list is duplicated in DOM for desktop/mobile
    // layouts (container-query toggled), so pick the visible copy.
    const formatSeededDate = (spec: (typeof TEST_EVENTS)[number]): string =>
      new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(
        new Date(
          spec.dateYear,
          (spec.dateMonth ?? 1) - 1,
          spec.dateDay ?? 1
        )
      );
    const firstDate = formatSeededDate(TEST_EVENTS[0]);
    const secondDate = formatSeededDate(TEST_EVENTS[1]);
    await expect(
      page.getByText(firstDate).filter({ visible: true }).first()
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByText(secondDate).filter({ visible: true }).first()
    ).toBeVisible({ timeout: 10000 });
  });

  test("event detail shows primary section and edit link", async ({ page }) => {
    await devLogin(page, "admin");
    await setLabsEnabled(page.request, true);
    const eventId = await getEventIdByTitle(page.request, TEST_EVENTS[0].title);

    await page.goto(URLS.event(eventId));
    await waitForPageReady(page);

    // The event detail page embeds the primary recording's player and
    // surfaces the event metadata in a side panel. Verify the seeded event
    // title is present as metadata and the edit-event link is reachable.
    await expect(
      page.getByText(TEST_EVENTS[0].title).filter({ visible: true }).first()
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("link", { name: /edit event/i })).toBeVisible({
      timeout: 10000,
    });
  });

  test("events tab selection persists after reload", async ({ page }) => {
    await loginAs(page, "admin");
    await setLabsEnabled(page.request, true);
    await page.goto(URLS.catalog);
    await waitForPageReady(page);

    await page.getByRole("tab", { name: "Events" }).click();
    await expect(page.getByRole("tab", { name: "Events" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    await page.reload();
    await waitForPageReady(page);

    await expect(page.getByRole("tab", { name: "Events" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(page.getByRole("button", { name: "Create Event" })).toBeVisible({
      timeout: 10000,
    });
  });

  test("admin can attach and detach an unassigned recording", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "Desktop Chrome",
      "Mutation test runs only on Desktop Chrome to avoid parallel DB races"
    );

    await devLogin(page, "admin");
    await setLabsEnabled(page.request, true);

    // All 5 seeded audio files are now attached to events (ab00003cab and
    // ab00004dab were added to "Archive Evening" for notification coverage),
    // so there are no unassigned recordings out of the box. Detach one via
    // the API first so the UI has something to re-attach.
    const cabinetEventId = await getEventIdByTitle(page.request, TEST_EVENTS[2].title);
    const targetEventId = await getEventIdByTitle(page.request, TEST_EVENTS[1].title);
    const unassignedHash = TEST_AUDIO_FILES[2].hash;
    const preDetach = await page.request.delete(
      `/api/catalogs/${TEST_CATALOG_ID}/events/${cabinetEventId}/recordings/${unassignedHash}`
    );
    // 404 is fine on re-runs where a prior run already detached it.
    expect([200, 204, 404]).toContain(preDetach.status());

    await page.goto(`/catalog/${TEST_CATALOG_ID}/event/${targetEventId}/edit`);
    await waitForPageReady(page);

    const hashRows = page.locator("tbody tr", { hasText: unassignedHash });
    const attachRow = hashRows
      .filter({ has: page.locator("button", { hasText: /^Attach$/ }) })
      .first();
    await expect(attachRow).toBeVisible({ timeout: 10000 });

    await attachRow.getByRole("button", { name: /^Attach$/ }).click();
    await expect(page.getByText("Recording attached")).toBeVisible({ timeout: 10000 });

    const attachedRow = hashRows
      .filter({ has: page.locator("button", { hasText: /^Detach$/ }) })
      .first();
    await expect(attachedRow).toBeVisible({ timeout: 10000 });

    await attachedRow.getByRole("button", { name: "Detach" }).click();
    await expect(page.getByText("Recording detached")).toBeVisible({ timeout: 10000 });
    await expect(
      hashRows.filter({ has: page.locator("button", { hasText: /^Detach$/ }) })
    ).toHaveCount(0);
  });

  test("release is blocked without primary, then succeeds after setting primary", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "Desktop Chrome",
      "Mutation test runs only on Desktop Chrome to avoid parallel DB races"
    );

    // Reset the event to a deterministic state (unreleased, no primary)
    // before logging in, in case a prior run left it released with a primary
    // set — which would make the "Release" button absent on the next run.
    await resetEventReleaseState(TEST_CATALOG_ID, TEST_EVENTS[1].title);

    await devLogin(page, "admin");
    await setLabsEnabled(page.request, true);
    const eventId = await getEventIdByTitle(page.request, TEST_EVENTS[1].title);
    const primaryHash = TEST_AUDIO_FILES[1].hash;

    // Release controls and attach/primary UI live on the event editor page.
    await page.goto(`/catalog/${TEST_CATALOG_ID}/event/${eventId}/edit`);
    await waitForPageReady(page);

    const releaseButton = page.getByRole("button", { name: "Release" });
    await expect(releaseButton).toBeVisible({ timeout: 10000 });
    await releaseButton.click();

    await expect(
      page.getByText(/cannot be released without exactly one primary recording/i)
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Unreleased")).toBeVisible({ timeout: 10000 });

    // The recordings table identifies rows by hash; recording titles are
    // not rendered here. Find the seeded recording row by its audio hash.
    const primaryRow = page.locator("tbody tr", { hasText: primaryHash }).first();
    await primaryRow.getByRole("button", { name: "Set primary" }).click();
    await expect(page.getByText("Primary recording updated")).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "Release" }).click();
    await expect(page.getByText("Event status updated")).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "Unrelease" })).toBeVisible({
      timeout: 10000,
    });
  });

  test("unassigned endpoint returns a well-formed entry list", async ({ page }) => {
    await devLogin(page, "admin");
    await setLabsEnabled(page.request, true);
    const response = await page.request.get(
      `/api/catalog-events/unassigned?group=${TEST_CATALOG_ID}&limit=200`
    );
    expect(response.ok()).toBeTruthy();

    // All seeded recordings are attached to events by default, so the list
    // can legitimately be empty. Assert the shape rather than specific
    // hashes — those are exercised by the attach/detach UI test.
    const body = (await response.json()) as { entries: Array<{ audioHash: string }> };
    expect(Array.isArray(body.entries)).toBe(true);
    for (const entry of body.entries) {
      expect(typeof entry.audioHash).toBe("string");
      expect(entry.audioHash).toHaveLength(64);
    }
  });
});
