-- Keep consent changes and refresh-family revocation in the same transaction.
-- INSERT also clears orphaned credentials from an older deleted consent before
-- reauthorization creates the replacement grant.
CREATE FUNCTION "revoke_refresh_tokens_with_oauth_consent"() RETURNS TRIGGER AS $$
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

CREATE TRIGGER "oauth_consent_revoke_refresh_tokens"
BEFORE INSERT OR DELETE ON "oauthConsent"
FOR EACH ROW
EXECUTE FUNCTION "revoke_refresh_tokens_with_oauth_consent"();

-- Refresh tokens are authorization grants, so creating one requires the
-- matching consent to still exist. Issuance takes a shared family lock, which
-- is compatible with the request wrapper's shared lock but conflicts with the
-- exclusive lock taken by consent insertion and deletion.
CREATE FUNCTION "require_oauth_consent_for_refresh_token"() RETURNS TRIGGER AS $$
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

CREATE TRIGGER "oauth_refresh_token_require_consent"
BEFORE INSERT OR UPDATE OF "clientId", "userId", "referenceId"
ON "oauthRefreshToken"
FOR EACH ROW
EXECUTE FUNCTION "require_oauth_consent_for_refresh_token"();
