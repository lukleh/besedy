--
-- PostgreSQL database dump
--


-- Dumped from database version 18.6 (Debian 18.6-1.pgdg12+2)
-- Dumped by pg_dump version 18.6 (Debian 18.6-1.pgdg12+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: AccessStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."AccessStatus" AS ENUM (
    'ACTIVE',
    'REVOKED'
);


--
-- Name: AuditAction; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."AuditAction" AS ENUM (
    'LOGIN',
    'LOGOUT',
    'LOGIN_FAILED',
    'PORTAL_ADMISSION_CREATED',
    'PORTAL_ADMISSION_UPDATED',
    'PORTAL_ADMISSION_CLAIMED',
    'PORTAL_ADMISSION_REVOKED',
    'PORTAL_ADMISSION_RESET',
    'PENDING_CATALOG_GRANT_CREATED',
    'PENDING_CATALOG_GRANT_UPDATED',
    'PENDING_CATALOG_GRANT_REVOKED',
    'PENDING_CATALOG_GRANT_CONSUMED',
    'USER_ADDED',
    'USER_ACTIVATED',
    'USER_BLOCKED',
    'USER_UNBLOCKED',
    'USER_DELETED',
    'ADMIN_ROLE_GRANTED',
    'ADMIN_ROLE_REVOKED',
    'CATALOG_ACCESS_GRANTED',
    'CATALOG_ACCESS_UPDATED',
    'CATALOG_ACCESS_REVOKED',
    'CATALOG_CREATED',
    'CATALOG_UPDATED',
    'CATALOG_DEACTIVATED',
    'CATALOG_VIEWED',
    'AUDIO_STREAMED',
    'AUDIO_DOWNLOADED',
    'TRANSCRIPT_VIEWED',
    'TRANSCRIPT_DOWNLOADED',
    'METADATA_UPDATED',
    'METADATA_VERIFIED',
    'METADATA_DELETED',
    'ACCESS_DENIED',
    'SUPERADMIN_ACCESS',
    'EVENT_ARTWORK_CREATED',
    'EVENT_ARTWORK_DELETED',
    'EVENT_ARTWORK_PUBLISHED',
    'EVENT_ARTWORK_UNPUBLISHED',
    'RECORDING_INGEST_REQUESTED',
    'RECORDING_INGEST_REMOVED',
    'TRANSCRIPT_CORRECTION_STARTED',
    'TRANSCRIPT_CORRECTION_ARCHIVED',
    'TRANSCRIPT_GUIDE_UPDATED',
    'TRANSCRIPT_PUBLISHED',
    'TRANSCRIPT_UNPUBLISHED',
    'TRANSCRIPT_ORIGINAL_DOWNLOADED'
);


--
-- Name: CatalogRole; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."CatalogRole" AS ENUM (
    'listener',
    'reader',
    'corrector',
    'host',
    'curator',
    'catalog_admin'
);


--
-- Name: CatalogSyncStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."CatalogSyncStatus" AS ENUM (
    'SUCCESS',
    'ERROR'
);


--
-- Name: McpToolOutcome; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."McpToolOutcome" AS ENUM (
    'SUCCESS',
    'ERROR',
    'DENIED'
);


--
-- Name: PendingCatalogGrantStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PendingCatalogGrantStatus" AS ENUM (
    'PENDING',
    'CONSUMED',
    'REVOKED'
);


--
-- Name: PortalAdmissionRevocationReason; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PortalAdmissionRevocationReason" AS ENUM (
    'ADMIN_DENIED',
    'LAST_SPONSOR_REMOVED'
);


--
-- Name: PortalAdmissionSource; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PortalAdmissionSource" AS ENUM (
    'STANDALONE',
    'PENDING_GRANT'
);


--
-- Name: PortalAdmissionStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PortalAdmissionStatus" AS ENUM (
    'PENDING',
    'CLAIMED',
    'REVOKED'
);


--
-- Name: RecordingIntakeStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."RecordingIntakeStatus" AS ENUM (
    'UPLOADING',
    'QUEUED',
    'RUNNING',
    'SUCCEEDED',
    'REJECTED',
    'FAILED',
    'CANCELLED',
    'REMOVING',
    'REMOVED'
);


--
-- Name: TranscriptDecisionKind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."TranscriptDecisionKind" AS ENUM (
    'APPROVE',
    'DISAPPROVE',
    'WITHDRAW'
);


--
-- Name: TranscriptPublicationStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."TranscriptPublicationStatus" AS ENUM (
    'PENDING',
    'ACTIVATING',
    'SUCCEEDED',
    'FAILED',
    'ROLLING_BACK',
    'ROLLED_BACK'
);


--
-- Name: TranscriptRevisionOrigin; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."TranscriptRevisionOrigin" AS ENUM (
    'MACHINE',
    'MANUAL',
    'SUGGESTION'
);


--
-- Name: TranscriptSpanFlagAction; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."TranscriptSpanFlagAction" AS ENUM (
    'SET',
    'CLEAR'
);


--
-- Name: TranscriptSpanFlagKind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."TranscriptSpanFlagKind" AS ENUM (
    'UNCLEAR',
    'OVERLAP',
    'OTHER_LANGUAGE',
    'MUSIC_NOISE',
    'CUT_WORD',
    'EXCLUDE_FROM_TRAINING'
);


--
-- Name: TranscriptWorkspaceStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."TranscriptWorkspaceStatus" AS ENUM (
    'ACTIVE',
    'ARCHIVED'
);


--
-- Name: UserStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."UserStatus" AS ENUM (
    'PENDING',
    'ACTIVE',
    'BLOCKED'
);


--
-- Name: WebUpdateEventType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."WebUpdateEventType" AS ENUM (
    'CLIENT_SEEN',
    'UPDATE_DETECTED',
    'WORKER_READY',
    'UPDATE_DISMISSED',
    'APPLY_REQUESTED',
    'APPLY_BLOCKED',
    'VERSION_PROBE_FAILED',
    'ACTIVATION_STARTED',
    'ACTIVATION_DELAYED',
    'ACTIVATION_COMPLETE',
    'RELOAD_FALLBACK',
    'REGISTRATION_FAILED'
);


--
-- Name: require_oauth_consent_for_refresh_token(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.require_oauth_consent_for_refresh_token() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: revoke_refresh_tokens_with_oauth_consent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revoke_refresh_tokens_with_oauth_consent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id text NOT NULL,
    user_id text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp(3) without time zone,
    refresh_token_expires_at timestamp(3) without time zone,
    scope text,
    password text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);


--
-- Name: albums; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.albums (
    id integer NOT NULL,
    name text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    workflow_group_id character varying(15) NOT NULL
);


--
-- Name: albums_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.albums_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: albums_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.albums_id_seq OWNED BY public.albums.id;


--
-- Name: audio_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audio_metadata (
    id integer NOT NULL,
    workflow_group_id character varying(15) NOT NULL,
    audio_hash character varying(64) NOT NULL,
    title text,
    artist text,
    date_year integer,
    date_month integer,
    date_day integer,
    notes text,
    tags text[] DEFAULT ARRAY[]::text[],
    verified boolean DEFAULT false NOT NULL,
    verified_at timestamp(3) without time zone,
    verified_by character varying(255),
    recorder_id integer,
    location_id integer,
    part integer,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    album_id integer
);


--
-- Name: audio_metadata_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audio_metadata_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audio_metadata_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audio_metadata_id_seq OWNED BY public.audio_metadata.id;


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id text NOT NULL,
    user_id text,
    action public."AuditAction" NOT NULL,
    resource character varying(50) NOT NULL,
    resource_id character varying(64),
    details jsonb,
    ip_address character varying(45),
    user_agent text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    domain character varying(50),
    subject_type character varying(50),
    subject_id character varying(191),
    catalog_id character varying(191),
    outcome character varying(20),
    payload_version integer
);


--
-- Name: catalog_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog_access (
    id text NOT NULL,
    user_id text NOT NULL,
    catalog_id character varying(15) NOT NULL,
    granted_by_id text,
    notes text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    revoked_at timestamp(3) without time zone,
    revoked_by_id text,
    status public."AccessStatus" DEFAULT 'ACTIVE'::public."AccessStatus" NOT NULL,
    role public."CatalogRole" NOT NULL,
    extra_permissions text[] DEFAULT ARRAY[]::text[] NOT NULL
);


--
-- Name: catalog_duplicate; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog_duplicate (
    workflow_group_id character varying(15) NOT NULL,
    audio_hash character varying(64) NOT NULL,
    original_path text NOT NULL,
    duplicate_path text NOT NULL,
    duplicate_payload jsonb,
    duplicate_payload_version integer DEFAULT 1 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);


--
-- Name: catalog_entry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog_entry (
    workflow_group_id character varying(15) NOT NULL,
    audio_hash character varying(64) NOT NULL,
    compressed_path text,
    original_path text,
    filename text,
    scan_root text,
    duration_hms character varying(8),
    source_title text,
    source_artist text,
    source_album text,
    source_date text,
    source_metadata_payload jsonb,
    source_archived_payload jsonb,
    details_payload_version integer DEFAULT 1 NOT NULL,
    has_archived boolean NOT NULL,
    has_metadata boolean NOT NULL,
    is_actionable boolean NOT NULL,
    duplicate_count integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    is_published boolean DEFAULT false NOT NULL,
    compressed_aac_path text
);


--
-- Name: catalog_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog_event (
    id integer NOT NULL,
    workflow_group_id character varying(15) NOT NULL,
    title text,
    location_id integer NOT NULL,
    date_year integer NOT NULL,
    date_month integer,
    date_day integer,
    description text,
    released boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_by text NOT NULL,
    updated_by text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    published_notified_at timestamp(3) without time zone,
    session_index integer DEFAULT 1 NOT NULL,
    CONSTRAINT catalog_event_session_index_check CHECK ((session_index >= 1))
);


--
-- Name: catalog_event_artwork; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog_event_artwork (
    id uuid NOT NULL,
    event_id integer NOT NULL,
    workflow_group_id character varying(15) NOT NULL,
    label character varying(255),
    square_extension character varying(8) NOT NULL,
    square_original_name character varying(255) NOT NULL,
    square_bytes integer NOT NULL,
    square_sha256 character varying(64) NOT NULL,
    landscape_extension character varying(8) NOT NULL,
    landscape_original_name character varying(255) NOT NULL,
    landscape_bytes integer NOT NULL,
    landscape_sha256 character varying(64) NOT NULL,
    created_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT catalog_event_artwork_landscape_bytes_check CHECK ((landscape_bytes > 0)),
    CONSTRAINT catalog_event_artwork_landscape_sha256_check CHECK (((landscape_sha256)::text ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT catalog_event_artwork_square_bytes_check CHECK ((square_bytes > 0)),
    CONSTRAINT catalog_event_artwork_square_sha256_check CHECK (((square_sha256)::text ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: catalog_event_artwork_publication; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog_event_artwork_publication (
    event_id integer NOT NULL,
    workflow_group_id character varying(15) NOT NULL,
    artwork_id uuid NOT NULL,
    published_by text,
    published_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: catalog_event_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.catalog_event_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: catalog_event_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.catalog_event_id_seq OWNED BY public.catalog_event.id;


--
-- Name: catalog_event_recording; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog_event_recording (
    event_id integer NOT NULL,
    workflow_group_id character varying(15) NOT NULL,
    audio_hash character varying(64) NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);


--
-- Name: catalog_sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog_sync_state (
    workflow_group_id character varying(15) NOT NULL,
    source_key text NOT NULL,
    file_path text NOT NULL,
    fingerprint text NOT NULL,
    row_count integer DEFAULT 0 NOT NULL,
    synced_at timestamp(3) without time zone NOT NULL,
    status public."CatalogSyncStatus" NOT NULL,
    last_error text,
    last_successful_at timestamp(3) without time zone
);


--
-- Name: client_error_report; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_error_report (
    id text NOT NULL,
    user_id text,
    message text NOT NULL,
    stack text,
    digest character varying(64),
    source character varying(50),
    url text,
    user_agent text,
    ip_address character varying(45),
    context jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: event_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_notifications (
    id text NOT NULL,
    user_id text NOT NULL,
    catalog_id character varying(15) NOT NULL,
    event_id integer NOT NULL,
    title text,
    is_read boolean DEFAULT false NOT NULL,
    read_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: jwks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jwks (
    id text NOT NULL,
    "publicKey" text NOT NULL,
    "privateKey" text NOT NULL,
    "createdAt" timestamp(3) without time zone NOT NULL,
    "expiresAt" timestamp(3) without time zone,
    alg text,
    crv text
);


--
-- Name: locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.locations (
    id integer NOT NULL,
    name text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    workflow_group_id character varying(15) NOT NULL
);


--
-- Name: locations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.locations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: locations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.locations_id_seq OWNED BY public.locations.id;


--
-- Name: mcp_tool_invocation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_tool_invocation (
    id text NOT NULL,
    user_id text,
    client_id text NOT NULL,
    client_name character varying(255),
    tool_name character varying(64) NOT NULL,
    catalog_id character varying(191),
    outcome public."McpToolOutcome" NOT NULL,
    error_code character varying(100),
    duration_ms integer NOT NULL,
    returned_text_chars integer,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    actor_user_id text NOT NULL,
    CONSTRAINT mcp_tool_invocation_duration_ms_check CHECK ((duration_ms >= 0)),
    CONSTRAINT mcp_tool_invocation_returned_text_chars_check CHECK (((returned_text_chars IS NULL) OR (returned_text_chars >= 0)))
);


--
-- Name: mcp_tool_usage_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_tool_usage_daily (
    id text NOT NULL,
    usage_date date NOT NULL,
    actor_user_id text NOT NULL,
    client_id text NOT NULL,
    client_name character varying(255),
    tool_name character varying(64) NOT NULL,
    catalog_id character varying(191) DEFAULT ''::character varying NOT NULL,
    outcome public."McpToolOutcome" NOT NULL,
    calls integer NOT NULL,
    total_duration_ms bigint NOT NULL,
    returned_text_chars bigint NOT NULL,
    first_used_at timestamp(3) without time zone NOT NULL,
    last_used_at timestamp(3) without time zone NOT NULL,
    CONSTRAINT mcp_tool_usage_daily_calls_check CHECK ((calls > 0)),
    CONSTRAINT mcp_tool_usage_daily_duration_check CHECK ((total_duration_ms >= 0)),
    CONSTRAINT mcp_tool_usage_daily_text_chars_check CHECK ((returned_text_chars >= 0))
);


--
-- Name: mcp_tool_usage; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.mcp_tool_usage AS
 SELECT mcp_tool_invocation.created_at AS occurred_at,
    mcp_tool_invocation.created_at AS last_used_at,
    mcp_tool_invocation.actor_user_id,
    mcp_tool_invocation.client_id,
    mcp_tool_invocation.client_name,
    mcp_tool_invocation.tool_name,
    mcp_tool_invocation.catalog_id,
    mcp_tool_invocation.outcome,
    (1)::bigint AS calls,
    (mcp_tool_invocation.duration_ms)::bigint AS total_duration_ms,
    (COALESCE(mcp_tool_invocation.returned_text_chars, 0))::bigint AS returned_text_chars
   FROM public.mcp_tool_invocation
UNION ALL
 SELECT (mcp_tool_usage_daily.usage_date)::timestamp without time zone AS occurred_at,
    mcp_tool_usage_daily.last_used_at,
    mcp_tool_usage_daily.actor_user_id,
    mcp_tool_usage_daily.client_id,
    mcp_tool_usage_daily.client_name,
    mcp_tool_usage_daily.tool_name,
    NULLIF((mcp_tool_usage_daily.catalog_id)::text, ''::text) AS catalog_id,
    mcp_tool_usage_daily.outcome,
    (mcp_tool_usage_daily.calls)::bigint AS calls,
    mcp_tool_usage_daily.total_duration_ms,
    mcp_tool_usage_daily.returned_text_chars
   FROM public.mcp_tool_usage_daily;


--
-- Name: oauthAccessToken; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."oauthAccessToken" (
    id text NOT NULL,
    token text NOT NULL,
    "clientId" text NOT NULL,
    "sessionId" text,
    "userId" text,
    "referenceId" text,
    "authorizationCodeId" text,
    resources text[],
    "requestedUserInfoClaims" text[],
    "refreshId" text,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone NOT NULL,
    revoked timestamp(3) without time zone,
    confirmation jsonb,
    scopes text[]
);


--
-- Name: oauthClient; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."oauthClient" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "clientSecret" text,
    "clientDiscoveryId" text,
    disabled boolean DEFAULT false,
    "skipConsent" boolean,
    "enableEndSession" boolean,
    "subjectType" text,
    scopes text[],
    "clientCredentialsScopes" text[] DEFAULT ARRAY[]::text[],
    "userId" text,
    "createdAt" timestamp(3) without time zone,
    "updatedAt" timestamp(3) without time zone,
    name text,
    uri text,
    icon text,
    contacts text[],
    tos text,
    policy text,
    "softwareId" text,
    "softwareVersion" text,
    "softwareStatement" text,
    "redirectUris" text[],
    "postLogoutRedirectUris" text[],
    "backchannelLogoutUri" text,
    "backchannelLogoutSessionRequired" boolean,
    "tokenEndpointAuthMethod" text,
    "applicationType" text,
    jwks text,
    "jwksUri" text,
    "grantTypes" text[],
    "responseTypes" text[],
    "requirePKCE" boolean,
    "dpopBoundAccessTokens" boolean DEFAULT false,
    "referenceId" text,
    metadata jsonb
);


--
-- Name: oauthClientAssertion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."oauthClientAssertion" (
    id text NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: oauthClientResource; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."oauthClientResource" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "resourceId" text NOT NULL,
    metadata jsonb,
    "createdAt" timestamp(3) without time zone
);


--
-- Name: oauthConsent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."oauthConsent" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "userId" text,
    "referenceId" text,
    resources text[],
    "requestedUserInfoClaims" text[],
    scopes text[],
    "createdAt" timestamp(3) without time zone NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: oauthRefreshToken; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."oauthRefreshToken" (
    id text NOT NULL,
    token text NOT NULL,
    "clientId" text NOT NULL,
    "sessionId" text,
    "userId" text NOT NULL,
    "referenceId" text,
    "authorizationCodeId" text,
    resources text[],
    "requestedUserInfoClaims" text[],
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone NOT NULL,
    revoked timestamp(3) without time zone,
    "rotatedAt" timestamp(3) without time zone,
    "rotationReplayResponse" text,
    "rotationReplayExpiresAt" timestamp(3) without time zone,
    "authTime" timestamp(3) without time zone,
    confirmation jsonb,
    scopes text[]
);


--
-- Name: oauthResource; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."oauthResource" (
    id text NOT NULL,
    identifier text NOT NULL,
    name text NOT NULL,
    "accessTokenTtl" integer,
    "refreshTokenTtl" integer,
    "signingAlgorithm" text,
    "signingKeyId" text,
    "allowedScopes" text[],
    "customClaims" jsonb,
    "dpopBoundAccessTokensRequired" boolean DEFAULT false,
    disabled boolean DEFAULT false,
    "createdAt" timestamp(3) without time zone,
    "updatedAt" timestamp(3) without time zone,
    "policyVersion" integer DEFAULT 1,
    metadata jsonb
);


--
-- Name: pending_catalog_grant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_catalog_grant (
    id text NOT NULL,
    email text NOT NULL,
    catalog_id character varying(15) NOT NULL,
    status public."PendingCatalogGrantStatus" NOT NULL,
    granted_by_id text,
    granted_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    consumed_by_id text,
    consumed_at timestamp(3) without time zone,
    revoked_by_id text,
    revoked_at timestamp(3) without time zone,
    notes text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    role public."CatalogRole" NOT NULL,
    extra_permissions text[] DEFAULT ARRAY[]::text[] NOT NULL
);


--
-- Name: portal_admission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_admission (
    id text NOT NULL,
    email text NOT NULL,
    source public."PortalAdmissionSource" NOT NULL,
    status public."PortalAdmissionStatus" NOT NULL,
    revocation_reason public."PortalAdmissionRevocationReason",
    admitted_by_id text,
    admitted_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    claimed_by_id text,
    claimed_at timestamp(3) without time zone,
    revoked_by_id text,
    revoked_at timestamp(3) without time zone,
    notes text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id text NOT NULL,
    user_id text NOT NULL,
    endpoint text NOT NULL,
    p256dh character varying(255) NOT NULL,
    auth character varying(64) NOT NULL,
    user_agent text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_used_at timestamp(3) without time zone
);


--
-- Name: ready_scan_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ready_scan_state (
    id integer NOT NULL,
    catalog_id character varying(15) NOT NULL,
    known_ready_hashes jsonb DEFAULT '[]'::jsonb NOT NULL,
    state_hash character varying(64) NOT NULL,
    last_scan_at timestamp(3) without time zone NOT NULL,
    ready_count integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);


--
-- Name: ready_scan_state_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ready_scan_state_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ready_scan_state_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ready_scan_state_id_seq OWNED BY public.ready_scan_state.id;


--
-- Name: recorders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recorders (
    id integer NOT NULL,
    name text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    workflow_group_id character varying(15) NOT NULL
);


--
-- Name: recorders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.recorders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recorders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.recorders_id_seq OWNED BY public.recorders.id;


--
-- Name: recording_bookmark; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recording_bookmark (
    id text NOT NULL,
    user_id text NOT NULL,
    workflow_group_id character varying(15) NOT NULL,
    audio_hash character varying(64) NOT NULL,
    position_sec double precision NOT NULL,
    comment text,
    excerpt text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);


--
-- Name: recording_intake; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recording_intake (
    id text NOT NULL,
    workflow_group_id character varying(15) NOT NULL,
    requested_by_id text,
    original_filename text NOT NULL,
    stored_filename text NOT NULL,
    mime_type text,
    expected_size_bytes bigint NOT NULL,
    received_bytes bigint DEFAULT 0 NOT NULL,
    received_chunks integer DEFAULT 0 NOT NULL,
    status public."RecordingIntakeStatus" DEFAULT 'UPLOADING'::public."RecordingIntakeStatus" NOT NULL,
    job_id uuid,
    audio_hash character varying(64),
    error_code text,
    error_message text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    finished_at timestamp(3) without time zone,
    progress_label text,
    progress_step integer,
    progress_step_started_at timestamp(3) without time zone,
    progress_total integer,
    started_at timestamp(3) without time zone
);


--
-- Name: recording_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recording_notifications (
    id text NOT NULL,
    user_id text NOT NULL,
    catalog_id character varying(15) NOT NULL,
    audio_hash character varying(64) NOT NULL,
    title text,
    batch_id character varying(36) NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    read_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: recording_playback_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recording_playback_progress (
    user_id text NOT NULL,
    audio_hash character varying(64) NOT NULL,
    position_sec double precision DEFAULT 0 NOT NULL,
    duration_sec double precision,
    completed_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id text NOT NULL,
    token text NOT NULL,
    user_id text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);


--
-- Name: transcript_backend_priority; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_backend_priority (
    id integer NOT NULL,
    backend character varying(255) NOT NULL,
    priority integer NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);


--
-- Name: transcript_backend_priority_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.transcript_backend_priority_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transcript_backend_priority_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.transcript_backend_priority_id_seq OWNED BY public.transcript_backend_priority.id;


--
-- Name: transcript_contributor_consent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_contributor_consent (
    id uuid NOT NULL,
    actor_key text NOT NULL,
    user_id text,
    terms_version character varying(32) NOT NULL,
    terms_text text NOT NULL,
    accepted_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: transcript_guide_revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_guide_revision (
    id uuid NOT NULL,
    workflow_group_id character varying(15) NOT NULL,
    body text NOT NULL,
    author_id text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: transcript_publication; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_publication (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_group_id character varying(15) NOT NULL,
    audio_hash character varying(64) NOT NULL,
    status public."TranscriptPublicationStatus" DEFAULT 'PENDING'::public."TranscriptPublicationStatus" NOT NULL,
    required_approvals integer DEFAULT 2 NOT NULL,
    guide_revision_id uuid,
    published_by text,
    span_count integer DEFAULT 0 NOT NULL,
    duration_seconds double precision DEFAULT 0 NOT NULL,
    artifact_sha256 character varying(64),
    previous_source_kind character varying(16),
    previous_source_ref text,
    attempt_count integer DEFAULT 0 NOT NULL,
    error_code character varying(64),
    error_message text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    activating_at timestamp(3) without time zone,
    finished_at timestamp(3) without time zone,
    search_source_fingerprint character varying(64),
    index_job_id uuid,
    index_requested_at timestamp(3) without time zone,
    search_source_path text,
    CONSTRAINT transcript_publication_required_approvals_check CHECK ((required_approvals >= 2))
);


--
-- Name: transcript_publication_span; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_publication_span (
    publication_id uuid NOT NULL,
    span_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    ordinal integer NOT NULL
);


--
-- Name: transcript_span; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_span (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    ordinal integer NOT NULL,
    start_seconds double precision NOT NULL,
    end_seconds double precision NOT NULL,
    original_text text NOT NULL,
    original_text_hash character varying(64) NOT NULL,
    current_revision_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    chunk_ordinal integer,
    end_sample integer,
    first_region_index integer,
    last_region_index integer,
    machine_words jsonb,
    speech_regions jsonb,
    start_sample integer,
    CONSTRAINT transcript_span_bounds_check CHECK ((end_seconds >= start_seconds)),
    CONSTRAINT transcript_span_contract_check CHECK ((((chunk_ordinal IS NULL) AND (first_region_index IS NULL) AND (last_region_index IS NULL) AND (start_sample IS NULL) AND (end_sample IS NULL) AND (speech_regions IS NULL) AND (machine_words IS NULL)) OR ((chunk_ordinal IS NOT NULL) AND (chunk_ordinal >= 0) AND (first_region_index IS NOT NULL) AND (first_region_index >= 0) AND (last_region_index IS NOT NULL) AND (last_region_index >= first_region_index) AND (start_sample IS NOT NULL) AND (start_sample >= 0) AND (end_sample IS NOT NULL) AND (end_sample > start_sample) AND (speech_regions IS NOT NULL) AND (jsonb_typeof(speech_regions) = 'array'::text) AND (machine_words IS NOT NULL) AND (jsonb_typeof(machine_words) = 'array'::text)))),
    CONSTRAINT transcript_span_ordinal_check CHECK ((ordinal >= 0))
);


--
-- Name: transcript_span_comment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_span_comment (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    span_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    author_id text,
    body text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    actor_key text NOT NULL,
    CONSTRAINT transcript_span_comment_body_check CHECK ((length(btrim(body)) > 0))
);


--
-- Name: transcript_span_decision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_span_decision (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    span_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    user_id text,
    kind public."TranscriptDecisionKind" NOT NULL,
    idempotency_key character varying(64),
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    actor_key text NOT NULL,
    command_name character varying(32),
    command_digest character varying(64),
    sequence bigint NOT NULL,
    heard_fraction double precision,
    max_playback_rate double precision,
    min_playback_rate double precision,
    CONSTRAINT transcript_span_decision_playback_check CHECK (((num_nulls(heard_fraction, min_playback_rate, max_playback_rate) = ANY (ARRAY[0, 3])) AND ((heard_fraction IS NULL) OR ((heard_fraction >= (0)::double precision) AND (heard_fraction <= (1)::double precision))) AND ((min_playback_rate IS NULL) OR (min_playback_rate > (0)::double precision)) AND ((max_playback_rate IS NULL) OR (max_playback_rate > (0)::double precision)) AND ((min_playback_rate IS NULL) OR (max_playback_rate IS NULL) OR (min_playback_rate <= max_playback_rate))))
);


--
-- Name: transcript_span_decision_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.transcript_span_decision_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transcript_span_decision_sequence_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.transcript_span_decision_sequence_seq OWNED BY public.transcript_span_decision.sequence;


--
-- Name: transcript_span_flag_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_span_flag_event (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    span_id uuid NOT NULL,
    kind public."TranscriptSpanFlagKind" NOT NULL,
    action public."TranscriptSpanFlagAction" NOT NULL,
    language_code character varying(8),
    comment text,
    actor_key text NOT NULL,
    user_id text,
    idempotency_key character varying(64),
    sequence bigint NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT transcript_span_flag_event_language_check CHECK (((language_code IS NULL) OR (kind = 'OTHER_LANGUAGE'::public."TranscriptSpanFlagKind")))
);


--
-- Name: transcript_span_flag_event_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.transcript_span_flag_event_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transcript_span_flag_event_sequence_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.transcript_span_flag_event_sequence_seq OWNED BY public.transcript_span_flag_event.sequence;


--
-- Name: transcript_span_revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_span_revision (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    span_id uuid NOT NULL,
    text text NOT NULL,
    text_hash character varying(64) NOT NULL,
    previous_revision_id uuid,
    author_id text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    actor_key text,
    guide_revision_id uuid,
    origin public."TranscriptRevisionOrigin",
    suggestion_backend character varying(255),
    CONSTRAINT transcript_span_revision_suggestion_check CHECK ((((suggestion_backend IS NULL) OR (origin = 'SUGGESTION'::public."TranscriptRevisionOrigin")) AND ((origin IS DISTINCT FROM 'SUGGESTION'::public."TranscriptRevisionOrigin") OR (suggestion_backend IS NOT NULL)))),
    CONSTRAINT transcript_span_revision_text_hash_check CHECK (((text_hash)::text ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: transcript_workspace; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_workspace (
    id uuid NOT NULL,
    workflow_group_id character varying(15) NOT NULL,
    audio_hash character varying(64) NOT NULL,
    source_backend character varying(255) NOT NULL,
    source_fingerprint character varying(64) NOT NULL,
    span_duration_seconds double precision DEFAULT 0 NOT NULL,
    span_count integer DEFAULT 0 NOT NULL,
    status public."TranscriptWorkspaceStatus" DEFAULT 'ACTIVE'::public."TranscriptWorkspaceStatus" NOT NULL,
    reader_publication_id uuid,
    search_publication_id uuid,
    started_by text,
    archived_by text,
    archive_reason text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    archived_at timestamp(3) without time zone,
    search_withdrawal_id uuid,
    search_withdrawal_job_id uuid,
    segmentation_params jsonb,
    segmentation_version character varying(32),
    source_chunk_count integer,
    staged_audio_path text,
    staged_audio_sha256 character varying(64),
    staged_audio_size bigint,
    CONSTRAINT transcript_workspace_archived_fields_check CHECK (((status = 'ARCHIVED'::public."TranscriptWorkspaceStatus") = (archived_at IS NOT NULL))),
    CONSTRAINT transcript_workspace_audio_hash_check CHECK (((audio_hash)::text ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT transcript_workspace_contract_check CHECK ((((segmentation_version IS NULL) AND (segmentation_params IS NULL) AND (source_chunk_count IS NULL) AND (staged_audio_path IS NULL) AND (staged_audio_size IS NULL) AND (staged_audio_sha256 IS NULL)) OR ((segmentation_version IS NOT NULL) AND (segmentation_params IS NOT NULL) AND (source_chunk_count IS NOT NULL) AND (source_chunk_count > 0) AND (staged_audio_path IS NOT NULL) AND (staged_audio_size IS NOT NULL) AND (staged_audio_size > 0) AND (staged_audio_sha256 IS NOT NULL) AND (length((staged_audio_sha256)::text) = 64)))),
    CONSTRAINT transcript_workspace_source_fingerprint_check CHECK (((source_fingerprint)::text ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: user_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_preferences (
    user_id character varying(255) NOT NULL,
    active_group character varying(15),
    theme character varying(10) DEFAULT 'system'::character varying NOT NULL,
    catalog_columns text[] DEFAULT ARRAY[]::text[],
    settings jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text NOT NULL,
    name text,
    email text,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    status public."UserStatus" DEFAULT 'PENDING'::public."UserStatus" NOT NULL,
    is_superadmin boolean DEFAULT false NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    invited_by_id text,
    invited_at timestamp(3) without time zone,
    activated_at timestamp(3) without time zone,
    last_login_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);


--
-- Name: verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verifications (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);


--
-- Name: web_deploy_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.web_deploy_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    git_commit character varying(40) NOT NULL,
    web_version character varying(64) NOT NULL,
    deployed_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deployed_by character varying(120),
    note character varying(500)
);


--
-- Name: web_update_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.web_update_event (
    id text NOT NULL,
    user_id text,
    event public."WebUpdateEventType" NOT NULL,
    attempt_id character varying(64) NOT NULL,
    client_version character varying(64),
    target_version character varying(64),
    worker_ready boolean,
    blocker_kinds text[] DEFAULT ARRAY[]::text[],
    route_group character varying(40),
    browser character varying(30),
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: workflow_group; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_group (
    id character varying(15) NOT NULL,
    label text,
    archived_catalog_path text NOT NULL,
    metadata_catalog_path text NOT NULL,
    duplicates_catalog_path text,
    transcripts_path text,
    is_active boolean DEFAULT true NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: albums id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.albums ALTER COLUMN id SET DEFAULT nextval('public.albums_id_seq'::regclass);


--
-- Name: audio_metadata id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_metadata ALTER COLUMN id SET DEFAULT nextval('public.audio_metadata_id_seq'::regclass);


--
-- Name: catalog_event id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_event ALTER COLUMN id SET DEFAULT nextval('public.catalog_event_id_seq'::regclass);


--
-- Name: locations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations ALTER COLUMN id SET DEFAULT nextval('public.locations_id_seq'::regclass);


--
-- Name: ready_scan_state id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ready_scan_state ALTER COLUMN id SET DEFAULT nextval('public.ready_scan_state_id_seq'::regclass);


--
-- Name: recorders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recorders ALTER COLUMN id SET DEFAULT nextval('public.recorders_id_seq'::regclass);


--
-- Name: transcript_backend_priority id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_backend_priority ALTER COLUMN id SET DEFAULT nextval('public.transcript_backend_priority_id_seq'::regclass);


--
-- Name: transcript_span_decision sequence; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_decision ALTER COLUMN sequence SET DEFAULT nextval('public.transcript_span_decision_sequence_seq'::regclass);


--
-- Name: transcript_span_flag_event sequence; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_flag_event ALTER COLUMN sequence SET DEFAULT nextval('public.transcript_span_flag_event_sequence_seq'::regclass);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: albums albums_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.albums
    ADD CONSTRAINT albums_pkey PRIMARY KEY (id);


--
-- Name: audio_metadata audio_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_metadata
    ADD CONSTRAINT audio_metadata_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: catalog_access catalog_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_access
    ADD CONSTRAINT catalog_access_pkey PRIMARY KEY (id);


--
-- Name: catalog_duplicate catalog_duplicate_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_duplicate
    ADD CONSTRAINT catalog_duplicate_pkey PRIMARY KEY (workflow_group_id, audio_hash, duplicate_path);


--
-- Name: catalog_entry catalog_entry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_entry
    ADD CONSTRAINT catalog_entry_pkey PRIMARY KEY (workflow_group_id, audio_hash);


--
-- Name: catalog_event_artwork catalog_event_artwork_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_event_artwork
    ADD CONSTRAINT catalog_event_artwork_pkey PRIMARY KEY (id);


--
-- Name: catalog_event_artwork_publication catalog_event_artwork_publication_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_event_artwork_publication
    ADD CONSTRAINT catalog_event_artwork_publication_pkey PRIMARY KEY (workflow_group_id, event_id);


--
-- Name: catalog_event catalog_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_event
    ADD CONSTRAINT catalog_event_pkey PRIMARY KEY (id);


--
-- Name: catalog_event_recording catalog_event_recording_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_event_recording
    ADD CONSTRAINT catalog_event_recording_pkey PRIMARY KEY (workflow_group_id, audio_hash);


--
-- Name: catalog_sync_state catalog_sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_sync_state
    ADD CONSTRAINT catalog_sync_state_pkey PRIMARY KEY (workflow_group_id, source_key);


--
-- Name: client_error_report client_error_report_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_error_report
    ADD CONSTRAINT client_error_report_pkey PRIMARY KEY (id);


--
-- Name: event_notifications event_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_notifications
    ADD CONSTRAINT event_notifications_pkey PRIMARY KEY (id);


--
-- Name: jwks jwks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jwks
    ADD CONSTRAINT jwks_pkey PRIMARY KEY (id);


--
-- Name: locations locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_pkey PRIMARY KEY (id);


--
-- Name: mcp_tool_invocation mcp_tool_invocation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tool_invocation
    ADD CONSTRAINT mcp_tool_invocation_pkey PRIMARY KEY (id);


--
-- Name: mcp_tool_usage_daily mcp_tool_usage_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tool_usage_daily
    ADD CONSTRAINT mcp_tool_usage_daily_pkey PRIMARY KEY (id);


--
-- Name: oauthAccessToken oauthAccessToken_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_pkey" PRIMARY KEY (id);


--
-- Name: oauthClientAssertion oauthClientAssertion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthClientAssertion"
    ADD CONSTRAINT "oauthClientAssertion_pkey" PRIMARY KEY (id);


--
-- Name: oauthClientResource oauthClientResource_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_pkey" PRIMARY KEY (id);


--
-- Name: oauthClient oauthClient_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthClient"
    ADD CONSTRAINT "oauthClient_pkey" PRIMARY KEY (id);


--
-- Name: oauthConsent oauthConsent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthConsent"
    ADD CONSTRAINT "oauthConsent_pkey" PRIMARY KEY (id);


--
-- Name: oauthRefreshToken oauthRefreshToken_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_pkey" PRIMARY KEY (id);


--
-- Name: oauthResource oauthResource_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthResource"
    ADD CONSTRAINT "oauthResource_pkey" PRIMARY KEY (id);


--
-- Name: pending_catalog_grant pending_catalog_grant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_catalog_grant
    ADD CONSTRAINT pending_catalog_grant_pkey PRIMARY KEY (id);


--
-- Name: portal_admission portal_admission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_admission
    ADD CONSTRAINT portal_admission_pkey PRIMARY KEY (id);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: ready_scan_state ready_scan_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ready_scan_state
    ADD CONSTRAINT ready_scan_state_pkey PRIMARY KEY (id);


--
-- Name: recorders recorders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recorders
    ADD CONSTRAINT recorders_pkey PRIMARY KEY (id);


--
-- Name: recording_bookmark recording_bookmark_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_bookmark
    ADD CONSTRAINT recording_bookmark_pkey PRIMARY KEY (id);


--
-- Name: recording_intake recording_intake_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_intake
    ADD CONSTRAINT recording_intake_pkey PRIMARY KEY (id);


--
-- Name: recording_notifications recording_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_notifications
    ADD CONSTRAINT recording_notifications_pkey PRIMARY KEY (id);


--
-- Name: recording_playback_progress recording_playback_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_playback_progress
    ADD CONSTRAINT recording_playback_progress_pkey PRIMARY KEY (user_id, audio_hash);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: transcript_backend_priority transcript_backend_priority_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_backend_priority
    ADD CONSTRAINT transcript_backend_priority_pkey PRIMARY KEY (id);


--
-- Name: transcript_contributor_consent transcript_contributor_consent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_contributor_consent
    ADD CONSTRAINT transcript_contributor_consent_pkey PRIMARY KEY (id);


--
-- Name: transcript_guide_revision transcript_guide_revision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_guide_revision
    ADD CONSTRAINT transcript_guide_revision_pkey PRIMARY KEY (id);


--
-- Name: transcript_publication transcript_publication_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_publication
    ADD CONSTRAINT transcript_publication_pkey PRIMARY KEY (id);


--
-- Name: transcript_publication_span transcript_publication_span_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_publication_span
    ADD CONSTRAINT transcript_publication_span_pkey PRIMARY KEY (publication_id, span_id);


--
-- Name: transcript_span_comment transcript_span_comment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_comment
    ADD CONSTRAINT transcript_span_comment_pkey PRIMARY KEY (id);


--
-- Name: transcript_span_decision transcript_span_decision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_decision
    ADD CONSTRAINT transcript_span_decision_pkey PRIMARY KEY (id);


--
-- Name: transcript_span_flag_event transcript_span_flag_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_flag_event
    ADD CONSTRAINT transcript_span_flag_event_pkey PRIMARY KEY (id);


--
-- Name: transcript_span transcript_span_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span
    ADD CONSTRAINT transcript_span_pkey PRIMARY KEY (id);


--
-- Name: transcript_span_revision transcript_span_revision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_revision
    ADD CONSTRAINT transcript_span_revision_pkey PRIMARY KEY (id);


--
-- Name: transcript_workspace transcript_workspace_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_workspace
    ADD CONSTRAINT transcript_workspace_pkey PRIMARY KEY (id);


--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: verifications verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verifications
    ADD CONSTRAINT verifications_pkey PRIMARY KEY (id);


--
-- Name: web_deploy_log web_deploy_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_deploy_log
    ADD CONSTRAINT web_deploy_log_pkey PRIMARY KEY (id);


--
-- Name: web_update_event web_update_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_update_event
    ADD CONSTRAINT web_update_event_pkey PRIMARY KEY (id);


--
-- Name: workflow_group workflow_group_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_group
    ADD CONSTRAINT workflow_group_pkey PRIMARY KEY (id);


--
-- Name: accounts_provider_id_account_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX accounts_provider_id_account_id_key ON public.accounts USING btree (provider_id, account_id);


--
-- Name: accounts_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_user_id_idx ON public.accounts USING btree (user_id);


--
-- Name: albums_workflow_group_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX albums_workflow_group_id_idx ON public.albums USING btree (workflow_group_id);


--
-- Name: albums_workflow_group_id_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX albums_workflow_group_id_name_key ON public.albums USING btree (workflow_group_id, name);


--
-- Name: audio_metadata_album_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audio_metadata_album_id_idx ON public.audio_metadata USING btree (album_id);


--
-- Name: audio_metadata_location_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audio_metadata_location_id_idx ON public.audio_metadata USING btree (location_id);


--
-- Name: audio_metadata_recorder_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audio_metadata_recorder_id_idx ON public.audio_metadata USING btree (recorder_id);


--
-- Name: audio_metadata_workflow_group_id_audio_hash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX audio_metadata_workflow_group_id_audio_hash_key ON public.audio_metadata USING btree (workflow_group_id, audio_hash);


--
-- Name: audit_log_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_action_idx ON public.audit_log USING btree (action);


--
-- Name: audit_log_catalog_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_catalog_id_created_at_idx ON public.audit_log USING btree (catalog_id, created_at);


--
-- Name: audit_log_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_created_at_idx ON public.audit_log USING btree (created_at);


--
-- Name: audit_log_domain_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_domain_created_at_idx ON public.audit_log USING btree (domain, created_at);


--
-- Name: audit_log_outcome_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_outcome_created_at_idx ON public.audit_log USING btree (outcome, created_at);


--
-- Name: audit_log_payload_version_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_payload_version_created_at_idx ON public.audit_log USING btree (payload_version, created_at);


--
-- Name: audit_log_resource_resource_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_resource_resource_id_idx ON public.audit_log USING btree (resource, resource_id);


--
-- Name: audit_log_subject_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_subject_id_created_at_idx ON public.audit_log USING btree (subject_id, created_at);


--
-- Name: audit_log_subject_type_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_subject_type_created_at_idx ON public.audit_log USING btree (subject_type, created_at);


--
-- Name: audit_log_user_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_user_id_created_at_idx ON public.audit_log USING btree (user_id, created_at);


--
-- Name: catalog_access_catalog_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_access_catalog_id_idx ON public.catalog_access USING btree (catalog_id);


--
-- Name: catalog_access_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_access_status_idx ON public.catalog_access USING btree (status);


--
-- Name: catalog_access_user_id_catalog_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX catalog_access_user_id_catalog_id_key ON public.catalog_access USING btree (user_id, catalog_id);


--
-- Name: catalog_duplicate_workflow_group_id_audio_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_duplicate_workflow_group_id_audio_hash_idx ON public.catalog_duplicate USING btree (workflow_group_id, audio_hash);


--
-- Name: catalog_entry_workflow_group_id_duplicate_count_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_entry_workflow_group_id_duplicate_count_idx ON public.catalog_entry USING btree (workflow_group_id, duplicate_count);


--
-- Name: catalog_entry_workflow_group_id_is_actionable_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_entry_workflow_group_id_is_actionable_idx ON public.catalog_entry USING btree (workflow_group_id, is_actionable);


--
-- Name: catalog_entry_workflow_group_id_is_published_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_entry_workflow_group_id_is_published_idx ON public.catalog_entry USING btree (workflow_group_id, is_published);


--
-- Name: catalog_entry_workflow_group_id_source_artist_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_entry_workflow_group_id_source_artist_idx ON public.catalog_entry USING btree (workflow_group_id, source_artist);


--
-- Name: catalog_entry_workflow_group_id_source_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_entry_workflow_group_id_source_date_idx ON public.catalog_entry USING btree (workflow_group_id, source_date);


--
-- Name: catalog_event_artwork_id_event_id_workflow_group_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX catalog_event_artwork_id_event_id_workflow_group_id_key ON public.catalog_event_artwork USING btree (id, event_id, workflow_group_id);


--
-- Name: catalog_event_artwork_publication_artwork_event_catalog_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX catalog_event_artwork_publication_artwork_event_catalog_key ON public.catalog_event_artwork_publication USING btree (artwork_id, event_id, workflow_group_id);


--
-- Name: catalog_event_artwork_publication_artwork_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX catalog_event_artwork_publication_artwork_id_key ON public.catalog_event_artwork_publication USING btree (artwork_id);


--
-- Name: catalog_event_artwork_publication_event_catalog_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX catalog_event_artwork_publication_event_catalog_key ON public.catalog_event_artwork_publication USING btree (event_id, workflow_group_id);


--
-- Name: catalog_event_artwork_workflow_group_id_event_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_event_artwork_workflow_group_id_event_id_created_at_idx ON public.catalog_event_artwork USING btree (workflow_group_id, event_id, created_at);


--
-- Name: catalog_event_id_workflow_group_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX catalog_event_id_workflow_group_id_key ON public.catalog_event USING btree (id, workflow_group_id);


--
-- Name: catalog_event_identity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX catalog_event_identity_idx ON public.catalog_event USING btree (workflow_group_id, location_id, date_year, COALESCE(date_month, 0), COALESCE(date_day, 0), session_index);


--
-- Name: catalog_event_recording_primary_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX catalog_event_recording_primary_idx ON public.catalog_event_recording USING btree (event_id) WHERE (is_primary = true);


--
-- Name: catalog_event_workflow_group_id_released_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_event_workflow_group_id_released_idx ON public.catalog_event USING btree (workflow_group_id, released);


--
-- Name: client_error_report_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_error_report_created_at_idx ON public.client_error_report USING btree (created_at);


--
-- Name: client_error_report_digest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_error_report_digest_idx ON public.client_error_report USING btree (digest);


--
-- Name: client_error_report_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_error_report_source_idx ON public.client_error_report USING btree (source);


--
-- Name: client_error_report_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_error_report_user_id_idx ON public.client_error_report USING btree (user_id);


--
-- Name: event_notifications_catalog_id_event_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_notifications_catalog_id_event_id_idx ON public.event_notifications USING btree (catalog_id, event_id);


--
-- Name: event_notifications_user_id_catalog_id_event_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX event_notifications_user_id_catalog_id_event_id_key ON public.event_notifications USING btree (user_id, catalog_id, event_id);


--
-- Name: event_notifications_user_id_is_read_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_notifications_user_id_is_read_idx ON public.event_notifications USING btree (user_id, is_read);


--
-- Name: locations_workflow_group_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX locations_workflow_group_id_idx ON public.locations USING btree (workflow_group_id);


--
-- Name: locations_workflow_group_id_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX locations_workflow_group_id_name_key ON public.locations USING btree (workflow_group_id, name);


--
-- Name: mcp_tool_invocation_actor_user_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tool_invocation_actor_user_id_created_at_idx ON public.mcp_tool_invocation USING btree (actor_user_id, created_at);


--
-- Name: mcp_tool_invocation_catalog_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tool_invocation_catalog_id_created_at_idx ON public.mcp_tool_invocation USING btree (catalog_id, created_at);


--
-- Name: mcp_tool_invocation_client_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tool_invocation_client_id_created_at_idx ON public.mcp_tool_invocation USING btree (client_id, created_at);


--
-- Name: mcp_tool_invocation_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tool_invocation_created_at_idx ON public.mcp_tool_invocation USING btree (created_at);


--
-- Name: mcp_tool_invocation_outcome_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tool_invocation_outcome_created_at_idx ON public.mcp_tool_invocation USING btree (outcome, created_at);


--
-- Name: mcp_tool_invocation_tool_name_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tool_invocation_tool_name_created_at_idx ON public.mcp_tool_invocation USING btree (tool_name, created_at);


--
-- Name: mcp_tool_invocation_user_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tool_invocation_user_id_created_at_idx ON public.mcp_tool_invocation USING btree (user_id, created_at);


--
-- Name: mcp_tool_usage_daily_actor_user_id_usage_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tool_usage_daily_actor_user_id_usage_date_idx ON public.mcp_tool_usage_daily USING btree (actor_user_id, usage_date);


--
-- Name: mcp_tool_usage_daily_catalog_id_usage_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tool_usage_daily_catalog_id_usage_date_idx ON public.mcp_tool_usage_daily USING btree (catalog_id, usage_date);


--
-- Name: mcp_tool_usage_daily_client_id_usage_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tool_usage_daily_client_id_usage_date_idx ON public.mcp_tool_usage_daily USING btree (client_id, usage_date);


--
-- Name: mcp_tool_usage_daily_dimensions_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mcp_tool_usage_daily_dimensions_key ON public.mcp_tool_usage_daily USING btree (usage_date, actor_user_id, client_id, tool_name, catalog_id, outcome);


--
-- Name: mcp_tool_usage_daily_tool_name_usage_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tool_usage_daily_tool_name_usage_date_idx ON public.mcp_tool_usage_daily USING btree (tool_name, usage_date);


--
-- Name: mcp_tool_usage_daily_usage_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tool_usage_daily_usage_date_idx ON public.mcp_tool_usage_daily USING btree (usage_date);


--
-- Name: oauthAccessToken_authorizationCodeId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON public."oauthAccessToken" USING btree ("authorizationCodeId");


--
-- Name: oauthAccessToken_clientId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthAccessToken_clientId_idx" ON public."oauthAccessToken" USING btree ("clientId");


--
-- Name: oauthAccessToken_refreshId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthAccessToken_refreshId_idx" ON public."oauthAccessToken" USING btree ("refreshId");


--
-- Name: oauthAccessToken_sessionId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthAccessToken_sessionId_idx" ON public."oauthAccessToken" USING btree ("sessionId");


--
-- Name: oauthAccessToken_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "oauthAccessToken_token_key" ON public."oauthAccessToken" USING btree (token);


--
-- Name: oauthAccessToken_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthAccessToken_userId_idx" ON public."oauthAccessToken" USING btree ("userId");


--
-- Name: oauthClientResource_clientId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthClientResource_clientId_idx" ON public."oauthClientResource" USING btree ("clientId");


--
-- Name: oauthClientResource_clientId_resourceId_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" ON public."oauthClientResource" USING btree ("clientId", "resourceId");


--
-- Name: oauthClientResource_resourceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthClientResource_resourceId_idx" ON public."oauthClientResource" USING btree ("resourceId");


--
-- Name: oauthClient_clientId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "oauthClient_clientId_key" ON public."oauthClient" USING btree ("clientId");


--
-- Name: oauthClient_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthClient_userId_idx" ON public."oauthClient" USING btree ("userId");


--
-- Name: oauthConsent_clientId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthConsent_clientId_idx" ON public."oauthConsent" USING btree ("clientId");


--
-- Name: oauthConsent_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthConsent_userId_idx" ON public."oauthConsent" USING btree ("userId");


--
-- Name: oauthRefreshToken_authorizationCodeId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON public."oauthRefreshToken" USING btree ("authorizationCodeId");


--
-- Name: oauthRefreshToken_clientId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthRefreshToken_clientId_idx" ON public."oauthRefreshToken" USING btree ("clientId");


--
-- Name: oauthRefreshToken_sessionId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthRefreshToken_sessionId_idx" ON public."oauthRefreshToken" USING btree ("sessionId");


--
-- Name: oauthRefreshToken_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "oauthRefreshToken_token_key" ON public."oauthRefreshToken" USING btree (token);


--
-- Name: oauthRefreshToken_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthRefreshToken_userId_idx" ON public."oauthRefreshToken" USING btree ("userId");


--
-- Name: oauthResource_identifier_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "oauthResource_identifier_key" ON public."oauthResource" USING btree (identifier);


--
-- Name: pending_catalog_grant_catalog_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pending_catalog_grant_catalog_id_idx ON public.pending_catalog_grant USING btree (catalog_id);


--
-- Name: pending_catalog_grant_consumed_by_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pending_catalog_grant_consumed_by_id_idx ON public.pending_catalog_grant USING btree (consumed_by_id);


--
-- Name: pending_catalog_grant_email_catalog_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pending_catalog_grant_email_catalog_id_key ON public.pending_catalog_grant USING btree (email, catalog_id);


--
-- Name: pending_catalog_grant_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pending_catalog_grant_email_idx ON public.pending_catalog_grant USING btree (email);


--
-- Name: pending_catalog_grant_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pending_catalog_grant_status_idx ON public.pending_catalog_grant USING btree (status);


--
-- Name: portal_admission_claimed_by_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_admission_claimed_by_id_idx ON public.portal_admission USING btree (claimed_by_id);


--
-- Name: portal_admission_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX portal_admission_email_key ON public.portal_admission USING btree (email);


--
-- Name: portal_admission_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_admission_status_idx ON public.portal_admission USING btree (status);


--
-- Name: push_subscriptions_endpoint_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX push_subscriptions_endpoint_key ON public.push_subscriptions USING btree (endpoint);


--
-- Name: push_subscriptions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX push_subscriptions_user_id_idx ON public.push_subscriptions USING btree (user_id);


--
-- Name: ready_scan_state_catalog_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ready_scan_state_catalog_id_key ON public.ready_scan_state USING btree (catalog_id);


--
-- Name: recorders_workflow_group_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recorders_workflow_group_id_idx ON public.recorders USING btree (workflow_group_id);


--
-- Name: recorders_workflow_group_id_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX recorders_workflow_group_id_name_key ON public.recorders USING btree (workflow_group_id, name);


--
-- Name: recording_bookmark_user_id_workflow_group_id_audio_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recording_bookmark_user_id_workflow_group_id_audio_hash_idx ON public.recording_bookmark USING btree (user_id, workflow_group_id, audio_hash);


--
-- Name: recording_bookmark_workflow_group_id_audio_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recording_bookmark_workflow_group_id_audio_hash_idx ON public.recording_bookmark USING btree (workflow_group_id, audio_hash);


--
-- Name: recording_intake_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recording_intake_created_at_idx ON public.recording_intake USING btree (created_at);


--
-- Name: recording_intake_job_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX recording_intake_job_id_key ON public.recording_intake USING btree (job_id);


--
-- Name: recording_intake_workflow_group_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recording_intake_workflow_group_id_status_idx ON public.recording_intake USING btree (workflow_group_id, status);


--
-- Name: recording_notifications_batch_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recording_notifications_batch_id_idx ON public.recording_notifications USING btree (batch_id);


--
-- Name: recording_notifications_user_id_catalog_id_audio_hash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX recording_notifications_user_id_catalog_id_audio_hash_key ON public.recording_notifications USING btree (user_id, catalog_id, audio_hash);


--
-- Name: recording_notifications_user_id_is_read_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recording_notifications_user_id_is_read_idx ON public.recording_notifications USING btree (user_id, is_read);


--
-- Name: recording_playback_progress_user_id_updated_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recording_playback_progress_user_id_updated_at_idx ON public.recording_playback_progress USING btree (user_id, updated_at);


--
-- Name: sessions_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sessions_token_key ON public.sessions USING btree (token);


--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id);


--
-- Name: transcript_backend_priority_backend_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_backend_priority_backend_key ON public.transcript_backend_priority USING btree (backend);


--
-- Name: transcript_contributor_consent_actor_key_terms_version_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_contributor_consent_actor_key_terms_version_key ON public.transcript_contributor_consent USING btree (actor_key, terms_version);


--
-- Name: transcript_guide_revision_workflow_group_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_guide_revision_workflow_group_id_created_at_idx ON public.transcript_guide_revision USING btree (workflow_group_id, created_at);


--
-- Name: transcript_publication_in_flight_per_workspace_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_publication_in_flight_per_workspace_key ON public.transcript_publication USING btree (workspace_id) WHERE (status = ANY (ARRAY['PENDING'::public."TranscriptPublicationStatus", 'ACTIVATING'::public."TranscriptPublicationStatus", 'ROLLING_BACK'::public."TranscriptPublicationStatus"]));


--
-- Name: transcript_publication_span_publication_id_ordinal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_publication_span_publication_id_ordinal_idx ON public.transcript_publication_span USING btree (publication_id, ordinal);


--
-- Name: transcript_publication_workflow_group_id_audio_hash_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_publication_workflow_group_id_audio_hash_status_idx ON public.transcript_publication USING btree (workflow_group_id, audio_hash, status);


--
-- Name: transcript_publication_workspace_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_publication_workspace_id_created_at_idx ON public.transcript_publication USING btree (workspace_id, created_at);


--
-- Name: transcript_span_comment_span_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_span_comment_span_id_created_at_idx ON public.transcript_span_comment USING btree (span_id, created_at);


--
-- Name: transcript_span_decision_revision_id_actor_key_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_span_decision_revision_id_actor_key_created_at_idx ON public.transcript_span_decision USING btree (revision_id, actor_key, created_at);


--
-- Name: transcript_span_decision_span_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_span_decision_span_id_created_at_idx ON public.transcript_span_decision USING btree (span_id, created_at);


--
-- Name: transcript_span_decision_workspace_id_actor_key_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_span_decision_workspace_id_actor_key_idempotency_key ON public.transcript_span_decision USING btree (workspace_id, actor_key, idempotency_key);


--
-- Name: transcript_span_flag_event_span_id_kind_sequence_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_span_flag_event_span_id_kind_sequence_idx ON public.transcript_span_flag_event USING btree (span_id, kind, sequence);


--
-- Name: transcript_span_flag_event_workspace_id_actor_key_idempoten_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_span_flag_event_workspace_id_actor_key_idempoten_key ON public.transcript_span_flag_event USING btree (workspace_id, actor_key, idempotency_key);


--
-- Name: transcript_span_revision_span_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_span_revision_span_id_created_at_idx ON public.transcript_span_revision USING btree (span_id, created_at);


--
-- Name: transcript_span_revision_workspace_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_span_revision_workspace_id_idx ON public.transcript_span_revision USING btree (workspace_id);


--
-- Name: transcript_span_workspace_id_chunk_ordinal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_span_workspace_id_chunk_ordinal_idx ON public.transcript_span USING btree (workspace_id, chunk_ordinal);


--
-- Name: transcript_span_workspace_id_ordinal_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_span_workspace_id_ordinal_key ON public.transcript_span USING btree (workspace_id, ordinal);


--
-- Name: transcript_span_workspace_id_start_seconds_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_span_workspace_id_start_seconds_idx ON public.transcript_span USING btree (workspace_id, start_seconds);


--
-- Name: transcript_workspace_live_per_recording_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_workspace_live_per_recording_key ON public.transcript_workspace USING btree (workflow_group_id, audio_hash) WHERE (status <> 'ARCHIVED'::public."TranscriptWorkspaceStatus");


--
-- Name: transcript_workspace_reader_publication_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_workspace_reader_publication_id_key ON public.transcript_workspace USING btree (reader_publication_id);


--
-- Name: transcript_workspace_search_publication_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transcript_workspace_search_publication_id_key ON public.transcript_workspace USING btree (search_publication_id);


--
-- Name: transcript_workspace_workflow_group_id_audio_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_workspace_workflow_group_id_audio_hash_idx ON public.transcript_workspace USING btree (workflow_group_id, audio_hash);


--
-- Name: transcript_workspace_workflow_group_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_workspace_workflow_group_id_status_idx ON public.transcript_workspace USING btree (workflow_group_id, status);


--
-- Name: users_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email);


--
-- Name: verifications_identifier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verifications_identifier_idx ON public.verifications USING btree (identifier);


--
-- Name: web_deploy_log_deployed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX web_deploy_log_deployed_at_idx ON public.web_deploy_log USING btree (deployed_at);


--
-- Name: web_deploy_log_web_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX web_deploy_log_web_version_idx ON public.web_deploy_log USING btree (web_version);


--
-- Name: web_update_event_attempt_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX web_update_event_attempt_id_idx ON public.web_update_event USING btree (attempt_id);


--
-- Name: web_update_event_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX web_update_event_created_at_idx ON public.web_update_event USING btree (created_at);


--
-- Name: web_update_event_event_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX web_update_event_event_created_at_idx ON public.web_update_event USING btree (event, created_at);


--
-- Name: web_update_event_target_version_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX web_update_event_target_version_created_at_idx ON public.web_update_event USING btree (target_version, created_at);


--
-- Name: oauthConsent oauth_consent_revoke_refresh_tokens; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER oauth_consent_revoke_refresh_tokens BEFORE INSERT OR DELETE ON public."oauthConsent" FOR EACH ROW EXECUTE FUNCTION public.revoke_refresh_tokens_with_oauth_consent();


--
-- Name: oauthRefreshToken oauth_refresh_token_require_consent; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER oauth_refresh_token_require_consent BEFORE INSERT OR UPDATE OF "clientId", "userId", "referenceId" ON public."oauthRefreshToken" FOR EACH ROW EXECUTE FUNCTION public.require_oauth_consent_for_refresh_token();


--
-- Name: accounts accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: albums albums_workflow_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.albums
    ADD CONSTRAINT albums_workflow_group_id_fkey FOREIGN KEY (workflow_group_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: audio_metadata audio_metadata_album_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_metadata
    ADD CONSTRAINT audio_metadata_album_id_fkey FOREIGN KEY (album_id) REFERENCES public.albums(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: audio_metadata audio_metadata_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_metadata
    ADD CONSTRAINT audio_metadata_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.locations(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: audio_metadata audio_metadata_recorder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_metadata
    ADD CONSTRAINT audio_metadata_recorder_id_fkey FOREIGN KEY (recorder_id) REFERENCES public.recorders(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: audio_metadata audio_metadata_workflow_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_metadata
    ADD CONSTRAINT audio_metadata_workflow_group_id_fkey FOREIGN KEY (workflow_group_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: audit_log audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: catalog_access catalog_access_catalog_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_access
    ADD CONSTRAINT catalog_access_catalog_id_fkey FOREIGN KEY (catalog_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: catalog_access catalog_access_granted_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_access
    ADD CONSTRAINT catalog_access_granted_by_id_fkey FOREIGN KEY (granted_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: catalog_access catalog_access_revoked_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_access
    ADD CONSTRAINT catalog_access_revoked_by_id_fkey FOREIGN KEY (revoked_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: catalog_access catalog_access_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_access
    ADD CONSTRAINT catalog_access_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: catalog_duplicate catalog_duplicate_workflow_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_duplicate
    ADD CONSTRAINT catalog_duplicate_workflow_group_id_fkey FOREIGN KEY (workflow_group_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: catalog_entry catalog_entry_workflow_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_entry
    ADD CONSTRAINT catalog_entry_workflow_group_id_fkey FOREIGN KEY (workflow_group_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: catalog_event_artwork catalog_event_artwork_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_event_artwork
    ADD CONSTRAINT catalog_event_artwork_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: catalog_event_artwork catalog_event_artwork_event_id_workflow_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_event_artwork
    ADD CONSTRAINT catalog_event_artwork_event_id_workflow_group_id_fkey FOREIGN KEY (event_id, workflow_group_id) REFERENCES public.catalog_event(id, workflow_group_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: catalog_event_artwork_publication catalog_event_artwork_publication_artwork_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_event_artwork_publication
    ADD CONSTRAINT catalog_event_artwork_publication_artwork_fkey FOREIGN KEY (artwork_id, event_id, workflow_group_id) REFERENCES public.catalog_event_artwork(id, event_id, workflow_group_id) ON UPDATE CASCADE;


--
-- Name: catalog_event_artwork_publication catalog_event_artwork_publication_event_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_event_artwork_publication
    ADD CONSTRAINT catalog_event_artwork_publication_event_fkey FOREIGN KEY (event_id, workflow_group_id) REFERENCES public.catalog_event(id, workflow_group_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: catalog_event_artwork_publication catalog_event_artwork_publication_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_event_artwork_publication
    ADD CONSTRAINT catalog_event_artwork_publication_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: catalog_event catalog_event_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_event
    ADD CONSTRAINT catalog_event_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: catalog_event catalog_event_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_event
    ADD CONSTRAINT catalog_event_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.locations(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: catalog_event_recording catalog_event_recording_event_id_workflow_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_event_recording
    ADD CONSTRAINT catalog_event_recording_event_id_workflow_group_id_fkey FOREIGN KEY (event_id, workflow_group_id) REFERENCES public.catalog_event(id, workflow_group_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: catalog_event_recording catalog_event_recording_workflow_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_event_recording
    ADD CONSTRAINT catalog_event_recording_workflow_group_id_fkey FOREIGN KEY (workflow_group_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: catalog_event catalog_event_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_event
    ADD CONSTRAINT catalog_event_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: catalog_event catalog_event_workflow_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_event
    ADD CONSTRAINT catalog_event_workflow_group_id_fkey FOREIGN KEY (workflow_group_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: catalog_sync_state catalog_sync_state_workflow_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_sync_state
    ADD CONSTRAINT catalog_sync_state_workflow_group_id_fkey FOREIGN KEY (workflow_group_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: client_error_report client_error_report_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_error_report
    ADD CONSTRAINT client_error_report_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: event_notifications event_notifications_catalog_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_notifications
    ADD CONSTRAINT event_notifications_catalog_id_fkey FOREIGN KEY (catalog_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: event_notifications event_notifications_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_notifications
    ADD CONSTRAINT event_notifications_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.catalog_event(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: event_notifications event_notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_notifications
    ADD CONSTRAINT event_notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: locations locations_workflow_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_workflow_group_id_fkey FOREIGN KEY (workflow_group_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: mcp_tool_invocation mcp_tool_invocation_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tool_invocation
    ADD CONSTRAINT mcp_tool_invocation_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: oauthAccessToken oauthAccessToken_clientId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES public."oauthClient"("clientId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: oauthAccessToken oauthAccessToken_refreshId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES public."oauthRefreshToken"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: oauthAccessToken oauthAccessToken_sessionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public.sessions(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: oauthAccessToken oauthAccessToken_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: oauthClientResource oauthClientResource_clientId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES public."oauthClient"("clientId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: oauthClientResource oauthClientResource_resourceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES public."oauthResource"(identifier) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: oauthClient oauthClient_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthClient"
    ADD CONSTRAINT "oauthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: oauthConsent oauthConsent_clientId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthConsent"
    ADD CONSTRAINT "oauthConsent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES public."oauthClient"("clientId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: oauthConsent oauthConsent_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthConsent"
    ADD CONSTRAINT "oauthConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: oauthRefreshToken oauthRefreshToken_clientId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES public."oauthClient"("clientId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: oauthRefreshToken oauthRefreshToken_sessionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public.sessions(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: oauthRefreshToken oauthRefreshToken_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: pending_catalog_grant pending_catalog_grant_catalog_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_catalog_grant
    ADD CONSTRAINT pending_catalog_grant_catalog_id_fkey FOREIGN KEY (catalog_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: pending_catalog_grant pending_catalog_grant_consumed_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_catalog_grant
    ADD CONSTRAINT pending_catalog_grant_consumed_by_id_fkey FOREIGN KEY (consumed_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: pending_catalog_grant pending_catalog_grant_granted_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_catalog_grant
    ADD CONSTRAINT pending_catalog_grant_granted_by_id_fkey FOREIGN KEY (granted_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: pending_catalog_grant pending_catalog_grant_revoked_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_catalog_grant
    ADD CONSTRAINT pending_catalog_grant_revoked_by_id_fkey FOREIGN KEY (revoked_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: portal_admission portal_admission_admitted_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_admission
    ADD CONSTRAINT portal_admission_admitted_by_id_fkey FOREIGN KEY (admitted_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: portal_admission portal_admission_claimed_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_admission
    ADD CONSTRAINT portal_admission_claimed_by_id_fkey FOREIGN KEY (claimed_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: portal_admission portal_admission_revoked_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_admission
    ADD CONSTRAINT portal_admission_revoked_by_id_fkey FOREIGN KEY (revoked_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: push_subscriptions push_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ready_scan_state ready_scan_state_catalog_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ready_scan_state
    ADD CONSTRAINT ready_scan_state_catalog_id_fkey FOREIGN KEY (catalog_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: recorders recorders_workflow_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recorders
    ADD CONSTRAINT recorders_workflow_group_id_fkey FOREIGN KEY (workflow_group_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: recording_bookmark recording_bookmark_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_bookmark
    ADD CONSTRAINT recording_bookmark_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: recording_bookmark recording_bookmark_workflow_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_bookmark
    ADD CONSTRAINT recording_bookmark_workflow_group_id_fkey FOREIGN KEY (workflow_group_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: recording_intake recording_intake_requested_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_intake
    ADD CONSTRAINT recording_intake_requested_by_id_fkey FOREIGN KEY (requested_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: recording_intake recording_intake_workflow_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_intake
    ADD CONSTRAINT recording_intake_workflow_group_id_fkey FOREIGN KEY (workflow_group_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: recording_notifications recording_notifications_catalog_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_notifications
    ADD CONSTRAINT recording_notifications_catalog_id_fkey FOREIGN KEY (catalog_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: recording_notifications recording_notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_notifications
    ADD CONSTRAINT recording_notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: recording_playback_progress recording_playback_progress_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_playback_progress
    ADD CONSTRAINT recording_playback_progress_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: transcript_contributor_consent transcript_contributor_consent_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_contributor_consent
    ADD CONSTRAINT transcript_contributor_consent_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: transcript_guide_revision transcript_guide_revision_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_guide_revision
    ADD CONSTRAINT transcript_guide_revision_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: transcript_guide_revision transcript_guide_revision_workflow_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_guide_revision
    ADD CONSTRAINT transcript_guide_revision_workflow_group_id_fkey FOREIGN KEY (workflow_group_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_publication transcript_publication_guide_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_publication
    ADD CONSTRAINT transcript_publication_guide_revision_id_fkey FOREIGN KEY (guide_revision_id) REFERENCES public.transcript_guide_revision(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_publication transcript_publication_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_publication
    ADD CONSTRAINT transcript_publication_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: transcript_publication_span transcript_publication_span_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_publication_span
    ADD CONSTRAINT transcript_publication_span_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.transcript_publication(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_publication_span transcript_publication_span_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_publication_span
    ADD CONSTRAINT transcript_publication_span_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES public.transcript_span_revision(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_publication_span transcript_publication_span_span_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_publication_span
    ADD CONSTRAINT transcript_publication_span_span_id_fkey FOREIGN KEY (span_id) REFERENCES public.transcript_span(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_publication transcript_publication_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_publication
    ADD CONSTRAINT transcript_publication_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.transcript_workspace(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_span_comment transcript_span_comment_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_comment
    ADD CONSTRAINT transcript_span_comment_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: transcript_span_comment transcript_span_comment_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_comment
    ADD CONSTRAINT transcript_span_comment_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES public.transcript_span_revision(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_span_comment transcript_span_comment_span_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_comment
    ADD CONSTRAINT transcript_span_comment_span_id_fkey FOREIGN KEY (span_id) REFERENCES public.transcript_span(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_span_comment transcript_span_comment_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_comment
    ADD CONSTRAINT transcript_span_comment_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.transcript_workspace(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_span transcript_span_current_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span
    ADD CONSTRAINT transcript_span_current_revision_id_fkey FOREIGN KEY (current_revision_id) REFERENCES public.transcript_span_revision(id);


--
-- Name: transcript_span_decision transcript_span_decision_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_decision
    ADD CONSTRAINT transcript_span_decision_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES public.transcript_span_revision(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_span_decision transcript_span_decision_span_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_decision
    ADD CONSTRAINT transcript_span_decision_span_id_fkey FOREIGN KEY (span_id) REFERENCES public.transcript_span(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_span_decision transcript_span_decision_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_decision
    ADD CONSTRAINT transcript_span_decision_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: transcript_span_decision transcript_span_decision_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_decision
    ADD CONSTRAINT transcript_span_decision_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.transcript_workspace(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_span_flag_event transcript_span_flag_event_span_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_flag_event
    ADD CONSTRAINT transcript_span_flag_event_span_id_fkey FOREIGN KEY (span_id) REFERENCES public.transcript_span(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_span_flag_event transcript_span_flag_event_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_flag_event
    ADD CONSTRAINT transcript_span_flag_event_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: transcript_span_flag_event transcript_span_flag_event_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_flag_event
    ADD CONSTRAINT transcript_span_flag_event_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.transcript_workspace(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_span_revision transcript_span_revision_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_revision
    ADD CONSTRAINT transcript_span_revision_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: transcript_span_revision transcript_span_revision_guide_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_revision
    ADD CONSTRAINT transcript_span_revision_guide_revision_id_fkey FOREIGN KEY (guide_revision_id) REFERENCES public.transcript_guide_revision(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_span_revision transcript_span_revision_previous_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_revision
    ADD CONSTRAINT transcript_span_revision_previous_revision_id_fkey FOREIGN KEY (previous_revision_id) REFERENCES public.transcript_span_revision(id);


--
-- Name: transcript_span_revision transcript_span_revision_span_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_revision
    ADD CONSTRAINT transcript_span_revision_span_id_fkey FOREIGN KEY (span_id) REFERENCES public.transcript_span(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_span_revision transcript_span_revision_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span_revision
    ADD CONSTRAINT transcript_span_revision_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.transcript_workspace(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_span transcript_span_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_span
    ADD CONSTRAINT transcript_span_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.transcript_workspace(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transcript_workspace transcript_workspace_archived_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_workspace
    ADD CONSTRAINT transcript_workspace_archived_by_fkey FOREIGN KEY (archived_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: transcript_workspace transcript_workspace_reader_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_workspace
    ADD CONSTRAINT transcript_workspace_reader_publication_id_fkey FOREIGN KEY (reader_publication_id) REFERENCES public.transcript_publication(id);


--
-- Name: transcript_workspace transcript_workspace_search_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_workspace
    ADD CONSTRAINT transcript_workspace_search_publication_id_fkey FOREIGN KEY (search_publication_id) REFERENCES public.transcript_publication(id);


--
-- Name: transcript_workspace transcript_workspace_started_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_workspace
    ADD CONSTRAINT transcript_workspace_started_by_fkey FOREIGN KEY (started_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: transcript_workspace transcript_workspace_workflow_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_workspace
    ADD CONSTRAINT transcript_workspace_workflow_group_id_fkey FOREIGN KEY (workflow_group_id) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: user_preferences user_preferences_active_group_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_active_group_fkey FOREIGN KEY (active_group) REFERENCES public.workflow_group(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: users users_invited_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_invited_by_id_fkey FOREIGN KEY (invited_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: web_update_event web_update_event_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_update_event
    ADD CONSTRAINT web_update_event_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--



-- Restore the connection search path before Prisma records completion.
RESET search_path;
