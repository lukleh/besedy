-- Besedy never marks an OAuth client as trusted (consent-skipping), and the
-- MCP authorization path now fails closed for such a client. Remove the
-- trusted-client branches added by 20260827150000 so the database enforces the
-- same rule: a refresh token exists only while its matching consent exists.
--
-- This restores the 20260827120000 function bodies. The per-family exclusive
-- lock on consent changes and the shared family lock on issuance stay, because
-- together with the request-level refresh lock they guarantee that a consent
-- deletion cannot race an in-flight refresh. The separate client-grant lock
-- level existed only to serialize trust changes and is dropped with them.

CREATE OR REPLACE FUNCTION "revoke_refresh_tokens_with_oauth_consent"() RETURNS TRIGGER AS $$
DECLARE
    family_client_id TEXT;
    family_user_id TEXT;
    family_reference_id TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        family_client_id := OLD."clientId";
        family_user_id := OLD."userId";
        family_reference_id := OLD."referenceId";
    ELSE
        family_client_id := NEW."clientId";
        family_user_id := NEW."userId";
        family_reference_id := NEW."referenceId";
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            jsonb_build_array(
                family_client_id,
                family_user_id,
                family_reference_id
            )::TEXT,
            0
        )
    );

    IF family_user_id IS NOT NULL THEN
        DELETE FROM "oauthRefreshToken"
        WHERE "clientId" = family_client_id
          AND "userId" = family_user_id
          AND "referenceId" IS NOT DISTINCT FROM family_reference_id;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "require_oauth_consent_for_refresh_token"() RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_advisory_xact_lock_shared(
        hashtextextended(
            jsonb_build_array(NEW."clientId", NEW."userId", NEW."referenceId")::TEXT,
            0
        )
    );

    IF NOT EXISTS (
        SELECT 1
        FROM "oauthConsent"
        WHERE "clientId" = NEW."clientId"
          AND "userId" = NEW."userId"
          AND "referenceId" IS NOT DISTINCT FROM NEW."referenceId"
    ) THEN
        RAISE EXCEPTION 'Cannot create an OAuth refresh token without active consent'
            USING ERRCODE = '23503',
                  TABLE = 'oauthRefreshToken',
                  CONSTRAINT = 'oauthRefreshToken_consent_fkey';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "oauth_client_synchronize_refresh_tokens_with_trust_change" ON "oauthClient";
DROP FUNCTION IF EXISTS "synchronize_refresh_tokens_with_trust_change"();
