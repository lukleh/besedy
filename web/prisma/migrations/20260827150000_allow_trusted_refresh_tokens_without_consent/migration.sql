-- Better Auth intentionally skips oauthConsent persistence for clients that an
-- administrator has marked as trusted. Consent and trusted-client changes must
-- therefore participate in one grant lifecycle.

-- Keep the existing family lock, but do not revoke a refresh family while the
-- client-level trusted grant remains active. The client grant lock serializes
-- this decision with skipConsent removal.
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

    PERFORM pg_advisory_xact_lock_shared(
        hashtextextended(
            jsonb_build_array('oauth-client-grant', family_client_id)::TEXT,
            0
        )
    );
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

    IF family_user_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM "oauthClient"
        WHERE "clientId" = family_client_id
          AND "skipConsent" IS TRUE
    ) THEN
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

-- Issuance takes shared client and family locks. Removing the trusted grant
-- takes the corresponding exclusive client lock below, preventing a refresh
-- row from being committed across the trust transition.
CREATE OR REPLACE FUNCTION "require_oauth_consent_for_refresh_token"() RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_advisory_xact_lock_shared(
        hashtextextended(
            jsonb_build_array('oauth-client-grant', NEW."clientId")::TEXT,
            0
        )
    );
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

-- Serialize every trusted-grant transition with consent changes and issuance.
-- When trust is removed, revoke only families without matching consent.
CREATE FUNCTION "synchronize_refresh_tokens_with_trust_change"() RETURNS TRIGGER AS $$
BEGIN
    IF OLD."skipConsent" IS DISTINCT FROM NEW."skipConsent" THEN
        PERFORM pg_advisory_xact_lock(
            hashtextextended(
                jsonb_build_array('oauth-client-grant', NEW."clientId")::TEXT,
                0
            )
        );
    END IF;

    IF OLD."skipConsent" IS TRUE AND NEW."skipConsent" IS NOT TRUE THEN
        DELETE FROM "oauthRefreshToken" AS refresh_token
        WHERE refresh_token."clientId" = NEW."clientId"
          AND NOT EXISTS (
              SELECT 1
              FROM "oauthConsent"
              WHERE "clientId" = refresh_token."clientId"
                AND "userId" = refresh_token."userId"
                AND "referenceId" IS NOT DISTINCT FROM refresh_token."referenceId"
          );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "oauth_client_synchronize_refresh_tokens_with_trust_change"
BEFORE UPDATE OF "skipConsent" ON "oauthClient"
FOR EACH ROW
EXECUTE FUNCTION "synchronize_refresh_tokens_with_trust_change"();
