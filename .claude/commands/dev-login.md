---
description: Get an authenticated session cookie for API testing with curl, by running the mock OAuth sign-in for a seeded test account.
argument-hint: <account> (e.g. corrector, curator, admin)
---

# Dev Login for API Testing

Sign in as a seeded test account through the mock OAuth provider and keep the
session cookie for curl. This runs the same flow as the "Sign in with Mock
OAuth" button, with `login_hint` choosing the account instead of the picker.

Works against the development and test stacks, which run the `mock-oauth`
Compose profile. Production has no mock provider.

## Usage

Set `BASE` to the stack's `AUTH_URL` (dev default `http://localhost:3001`,
test `http://localhost:3002`) and `EMAIL` to the account:

```bash
BASE=http://localhost:3001
EMAIL=corrector@besedy.test
JAR=$(mktemp)

url=$(curl -s -c "$JAR" -b "$JAR" -H "Origin: $BASE" \
  -H "Content-Type: application/json" \
  -d '{"provider":"mock-oauth","callbackURL":"/catalog","errorCallbackURL":"/catalog"}' \
  "$BASE/api/auth/sign-in/social" | jq -r .url)
curl -s -c "$JAR" -b "$JAR" -L -o /dev/null -w '%{url_effective}\n' \
  "$url&login_hint=$EMAIL"
```

The last command prints where the sign-in landed: `/catalog/<id>` for an
account with catalog access, `/auth/no-access` or `/auth/signin` otherwise.

Then call any API with the cookie jar:

```bash
curl -s -b "$JAR" "$BASE/api/archive"
```

## Accounts

Source of truth: `web/prisma/test-data.ts` and the seeds `prisma/seed-dev.ts`
and `prisma/seed-test.ts`. All use `@besedy.test`:

- System: `superadmin`, `admin`
- One per catalog role: `catalog-admin`, `curator`, `host`, `corrector`,
  `reader`, `listener`
- `downloader`: a reader with the `download_audio` extra
- States: `noaccess`, `pending`, `blocked`

Catalog accounts are invitations in the dev seed: the first sign-in creates
the user and claims the grant. Run `just dev-seed` first if the account is
missing.

## Notes

- `$BASE` must be the stack's `AUTH_URL`; the mock provider redirects back to
  it, and Better Auth rejects other origins.
- Right after an invitation is claimed, `/api/auth/get-session` may still
  report `PENDING` from the session cache; the database row is `ACTIVE`.
- Playwright tests do not use this flow: `loginAs()` in
  `web/tests/e2e/helpers/auth.ts` writes the session directly.
