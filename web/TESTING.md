# Testing Standards

This document defines testing standards to avoid the "testing presence not correctness" anti-pattern.

## The Core Principle

**Tests should verify correctness, not just presence.**

```typescript
// BAD - Only checks if something exists
await expect(page.locator("main")).toBeVisible();
expect(result).toBeDefined();

// GOOD - Verifies actual behavior and data
await expect(page.getByText("Welcome, John")).toBeVisible();
expect(result.users).toHaveLength(3);
expect(result.users[0].email).toBe("test@example.com");
```

## Anti-Patterns to Avoid

### 1. Generic Element Visibility

```typescript
// BAD
await expect(page.locator("main")).toBeVisible();
await expect(page.locator("table")).toBeVisible();

// GOOD - Verify specific content
await expect(page.getByRole("heading", { name: "User Settings" })).toBeVisible();
await expect(page.locator("table tbody tr")).toHaveCount(5);
```

### 2. Loose OR Conditions

```typescript
// BAD - Passes if ANY condition is true
const hasButton = await button.isVisible().catch(() => false);
const hasLink = await link.isVisible().catch(() => false);
expect(hasButton || hasLink).toBe(true);

// GOOD - Test specific expected element
await expect(page.getByRole("button", { name: "Save Changes" })).toBeVisible();
```

### 3. Overly Loose Regex

```typescript
// BAD - Matches anything with "button" in it
const btn = page.getByRole("button", { name: /button|link|action|click/i });

// GOOD - Match specific text
const saveButton = page.getByRole("button", { name: "Save" });
const cancelButton = page.getByRole("button", { name: "Cancel" });
```

### 4. Testing Truthiness Only

```typescript
// BAD
expect(result).toBeTruthy();
expect(errors.length).toBeGreaterThan(0);

// GOOD
expect(result.status).toBe("success");
expect(errors).toContain("Invalid email format");
```

### 5. Empty Assertions

```typescript
// BAD - This test does nothing
expect(true).toBe(true);
expect(page.url()).toBeDefined();

// GOOD - Verify actual URL or state
await expect(page).toHaveURL(/\/settings$/);
expect(response.status).toBe(200);
```

### 6. Misleading Test Names

```typescript
// BAD - Name doesn't match what's tested
test("should show catalog configuration", async ({ page }) => {
  // Actually tests a button, not configuration
  const btn = page.getByRole("button", { name: /grant/i });
  await expect(btn).toBeVisible();
});

// GOOD - Name matches assertion
test("should show grant access button", async ({ page }) => {
  const grantBtn = page.getByRole("button", { name: "Grant Access" });
  await expect(grantBtn).toBeVisible();
});
```

## Best Practices

### 1. Use Console Error Detection

```typescript
import { createConsoleErrorCollector } from "./helpers/navigation";

test("page loads without JS errors", async ({ page }) => {
  const collector = createConsoleErrorCollector(page);
  collector.start();

  await page.goto("/dashboard");
  await doInteractions(page);

  collector.stop();
  // Ignore expected 403 for non-admin accessing admin endpoints
  collector.assertNoErrors([/Admin access required/i]);
});
```

### 2. Verify Actual Data

```typescript
// Verify table has real data, not just exists
test("displays user list", async ({ page }) => {
  await page.goto("/admin/users");
  await waitForTableData(page);

  // Verify specific user data
  await expect(page.getByText("admin@example.com")).toBeVisible();
  await expect(page.getByText("Active")).toBeVisible();

  // Verify count
  const rows = page.locator("table tbody tr");
  await expect(rows).toHaveCount(5);
});
```

### 3. Test Role-Specific Behavior

```typescript
test("owner sees access management but not config", async ({ page }) => {
  await loginAsOwner(page);
  await page.goto("/catalog/123/settings");

  // SHOULD see
  await expect(page.getByText("Users with Access")).toBeVisible();
  await expect(page.getByRole("button", { name: "Grant Access" })).toBeVisible();

  // Should NOT see (admin-only)
  await expect(page.getByText("Catalog Configuration")).toBeHidden();
});
```

### 4. Verify Persistence

```typescript
test("saves changes correctly", async ({ page }) => {
  await page.goto("/settings");

  // Make change
  await page.fill('[name="displayName"]', "New Name");
  await page.click('button[type="submit"]');

  // Wait for save
  await expect(page.getByText("Changes saved")).toBeVisible();

  // Reload and verify persistence
  await page.reload();
  await expect(page.locator('[name="displayName"]')).toHaveValue("New Name");
});
```

### 5. Test API Response Structure

```typescript
test("API returns correct structure", async ({ page }) => {
  await loginAsOwner(page);

  const responsePromise = page.waitForResponse(
    (r) => r.url().includes("/api/users") && r.status() === 200
  );

  await page.goto("/admin/users");
  const response = await responsePromise;
  const data = await response.json();

  // Verify structure, not just existence
  expect(data).toHaveProperty("users");
  expect(Array.isArray(data.users)).toBe(true);
  expect(data.users[0]).toHaveProperty("email");
  expect(data.users[0]).toHaveProperty("role");
  // Verify sensitive fields are excluded
  expect(data.users[0]).not.toHaveProperty("password");
});
```

### 6. Negative Assertions

```typescript
test("blocked user cannot access protected pages", async ({ page }) => {
  await loginAsBlocked(page);
  await page.goto("/catalog");

  // Should NOT see catalog content
  await expect(page.locator("table")).toBeHidden();
  await expect(page.getByText("recordings")).toBeHidden();

  // SHOULD see access denied message
  await expect(page.getByText(/blocked|access denied/i)).toBeVisible();
});
```

## Unit Test Standards

### 1. Verify Actual Values

```typescript
// BAD
expect(permissions.length).toBe(11);

// GOOD
expect(permissions).toContain("MANAGE_USERS");
expect(permissions).toContain("VIEW_TRANSCRIPTS");
expect(permissions).not.toContain("INVALID_PERMISSION");
```

### 2. Reduce Mocking

```typescript
// BAD - 7 mocks for 1 assertion
vi.mock("@/lib/auth");
vi.mock("@/lib/db");
vi.mock("@/lib/visibility");
// ... 4 more mocks
it("blocks unauthorized access", () => {
  // Just one assertion
});

// GOOD - Only mock what's necessary
vi.mock("@/lib/db");
it("blocks unauthorized access", async () => {
  const response = await GET(mockRequest);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "Forbidden" });
});
```

### 3. Test Happy Path + Edge Cases

```typescript
describe("validateEmail", () => {
  // Happy path
  it("accepts valid email", () => {
    expect(validateEmail("user@example.com")).toBe(true);
  });

  // Edge cases
  it("rejects email without @", () => {
    expect(validateEmail("invalid")).toBe(false);
  });

  it("handles unicode in local part", () => {
    expect(validateEmail("用户@example.com")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateEmail("")).toBe(false);
  });
});
```

## Checklist Before Committing Tests

- [ ] Tests verify correctness, not just presence
- [ ] No `expect(true).toBe(true)` or similar empty assertions
- [ ] Test names accurately describe what's being tested
- [ ] Role-specific behavior is tested with both positive and negative assertions
- [ ] Data is verified, not just that elements exist
- [ ] Console error detection is used for UI tests
- [ ] API response structures are validated
- [ ] Persistence is verified for CRUD operations
- [ ] Edge cases are covered, not just happy path
