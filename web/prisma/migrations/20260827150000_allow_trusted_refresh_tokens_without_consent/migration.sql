-- Better Auth intentionally skips oauthConsent persistence for clients that an
-- administrator has marked as trusted. Treat that client flag as the grant
-- when enforcing refresh-token issuance; all other clients still require the
-- matching live consent row.
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
        FROM "oauthClient"
        WHERE "clientId" = NEW."clientId"
          AND "skipConsent" IS TRUE
    ) AND NOT EXISTS (
        SELECT 1
        FROM "oauthConsent"
        WHERE "clientId" = NEW."clientId"
          AND "userId" = NEW."userId"
          AND "referenceId" IS NOT DISTINCT FROM NEW."referenceId"
    ) THEN
        RAISE EXCEPTION 'Cannot create an OAuth refresh token without active consent or a trusted client'
            USING ERRCODE = '23503',
                  TABLE = 'oauthRefreshToken',
                  CONSTRAINT = 'oauthRefreshToken_consent_fkey';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
