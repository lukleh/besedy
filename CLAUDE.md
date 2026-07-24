# CLAUDE.md

Shared repo workflow is canonical in `AGENTS.md`.
This file is intentionally small and only keeps Claude-specific pointers so we
do not duplicate command lists, seeded test users, or operational constraints.

## Shared Sources of Truth

- Shared agent workflow and repo rules: `AGENTS.md`
- Current catalog CLI surface: `besedy/cli/catalog.py`
- Parser coverage for command names: `tests/test_cli_parser.py`
- Seeded web auth users: `web/prisma/test-data.ts`
- Web E2E auth helpers: `web/tests/e2e/helpers/auth.ts`
- Claude-specific repo assets: `.claude/README.md`

## Claude-Specific Notes

- If you need shared project facts, update `AGENTS.md` instead of copying them
  here.
- Keep Claude Code hooks, commands, skills, and subagents in `.claude/` and
  document them in `.claude/README.md`.
- Prefer live source files over prose when checking fast-changing facts such as
  command names, seeded users, redirects, or auth behavior.
