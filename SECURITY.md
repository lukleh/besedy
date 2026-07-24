# Security Policy

Besedy is a personal, single-maintainer project. Security reports are welcome and
taken seriously, but handling is best-effort — there is no dedicated security team
or guaranteed response time.

## Reporting a Vulnerability

Please report security vulnerabilities **privately**. Do not open a public issue,
pull request, or discussion for a suspected vulnerability.

Use GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Fill in the details (see "What to include" below).

This creates a private advisory visible only to you and the maintainer. If private
reporting happens to be unavailable, open a minimal public issue asking for a
private contact channel — **without** any vulnerability details — and wait for a
reply.

### What to Include

- A description of the vulnerability and its impact.
- Steps to reproduce, or a proof of concept.
- The affected component (CLI toolkit, web app, backend runtime, or deployment
  tooling) and the version or commit.
- A suggested remediation, if you have one.

## What to Expect

- Acknowledgement on a best-effort basis — this is a solo project, so please allow
  time.
- If confirmed, a fix on `main` and a published advisory once the fix is available.
- Credit for the report if you would like it; just say so.

Please practice coordinated disclosure: allow a reasonable window for a fix before
disclosing publicly.

## Supported Versions

Besedy is developed on `main` and has no formal releases or long-term support
branches. Only the current `main` receives security fixes; there are no backports.

| Version | Supported |
|---------|-----------|
| `main` (latest) | ✅ |
| older commits / forks | ❌ |

## Scope

In scope — vulnerabilities in this repository's own code:

- the Python speech-to-text toolkit (`besedy/`)
- the Next.js web application (`web/`)
- Besedy's backend build and orchestration code under `backends/`
- the deployment tooling in this repo (compose files, setup scripts)

Out of scope:

- Upstream third-party ML models and their original backend code — report those
  to their upstream projects (see [NOTICE.md](NOTICE.md) and the model table in
  [README.md](README.md#third-party-models--licenses)). Besedy-owned backend
  build and orchestration code remains in scope (see above).
- Findings that require an already-compromised host, physical access, or a
  privileged local account.
- Behaviour that only occurs when security features are explicitly disabled or
  configured against the guidance in [docs/web/security.md](docs/web/security.md).

## Hosted Instance

`besedy.org` is the maintainer's personal deployment. Vulnerabilities affecting it
can be reported through the same private channel above.
