# Claude Repo Reference

> **Status:** Active
> **Last Updated:** 2026-04-04

This file documents the Claude-specific assets checked into this repo. It is
not a generic Claude Code manual.

## Current Assets

### Commands

- `.claude/commands/dev-login.md`
  - helper for local API testing through `/api/auth/dev-login`
  - assumes the dev stack is running and dev auth is enabled
- `.claude/commands/visual-qa.md`
  - workflow wrapper for screenshot-based visual QA across users and viewports
  - reads `.claude/visual-qa.json`

### Agents

- `.claude/agents/visual-qa-checker.md`
  - signs in as one user, screenshots configured pages, and records issues
- `.claude/agents/visual-qa-reporter.md`
  - combines per-user results into a browsable HTML report

### Settings

- `.claude/settings.json`
  - currently contains one active `PreToolUse` hook
  - blocks dangerous Prisma commands such as `prisma db push` and
    `prisma migrate reset`

### Configuration

- `.claude/visual-qa.json`
  - source of truth for visual QA users, pages, viewports, and output location

## Working Rules

- Keep shared repo workflow in `AGENTS.md`, not here.
- Keep Claude-specific pointers in `CLAUDE.md` and this file.
- Prefer live source files over prose for fast-changing facts such as CLI
  command names, seeded users, auth flows, and page routes.

## When To Update This File

Update this file when you:

- add or remove tracked files under `.claude/`
- change the active hook set in `.claude/settings.json`
- change the intended workflow for the checked-in Claude commands or agents

Do not use this file for general Besedy workflow rules or generic Claude Code
feature explanations.
