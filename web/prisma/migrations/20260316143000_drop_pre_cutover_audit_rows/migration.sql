-- Pre-cutover audit rows never received canonical contract fields.
-- The redesigned admin audit surface is canonical-only, so we permanently
-- drop older rows instead of carrying a parallel legacy path.
-- Rollout requirement: apply this migration only together with, or after,
-- the release that writes canonical audit fields on every new event.
-- Running it against older app code can delete newly written rows because the
-- previous writer also stored domain = NULL.
DELETE FROM "audit_log"
WHERE "domain" IS NULL;
