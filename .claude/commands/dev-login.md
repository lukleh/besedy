---
description: Get authenticated session for API testing with curl. Use when testing API endpoints locally without going through OAuth flow.
argument-hint: <email> (e.g., admin@besedy.test)
---

# Dev Login for API Testing

Obtain session cookies for testing API endpoints directly with curl or other HTTP clients.

## Quick Usage

Get session for admin user:
```bash
curl -c cookies.txt "http://localhost:3001/api/auth/dev-login?email=admin@besedy.test"
```

Use cookies with any API:
```bash
curl -b cookies.txt http://localhost:3001/api/catalogs
```

## Available Test Users

| Email | Role | Access |
|-------|------|--------|
| superadmin@besedy.test | Superadmin | Full system access |
| admin@besedy.test | Admin | User/catalog management |
| owner@besedy.test | User | OWNER on test catalog |
| editor@besedy.test | User | EDITOR on test catalog |
| member@besedy.test | User | MEMBER on test catalog |
| viewer@besedy.test | User | VIEWER on test catalog |
| listener@besedy.test | User | LISTENER (no transcripts) |
| noaccess@besedy.test | User | No catalog access |
| pending@besedy.test | User | PENDING status |
| blocked@besedy.test | User | BLOCKED status |

## Requirements

- Dev environment running: `just dev-up`
- `DEV_AUTH_ENABLED=true` in `.env.dev` (copy from `.env.dev.example`)

## Response Format

The endpoint returns JSON with user and session info:
```json
{
  "success": true,
  "user": {
    "id": "...",
    "email": "admin@besedy.test",
    "name": "Admin User",
    "status": "ACTIVE",
    "isSuperadmin": false,
    "isAdmin": true
  },
  "session": {
    "id": "...",
    "expiresAt": "2024-01-18T..."
  }
}
```

## E2E Test Usage

In Playwright tests, use the `devLogin()` helper for API-focused tests:
```typescript
import { devLogin } from "./helpers/auth";

// Faster than OAuth flow
await devLogin(page, "admin");
const response = await page.request.get("/api/catalogs");
```

## Security Note

This endpoint only works when:
1. `NODE_ENV !== 'production'`
2. `DEV_AUTH_ENABLED=true` is set

It returns 404 in production environments.
