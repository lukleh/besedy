import { betterAuth, type BetterAuthOptions } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth, jwt } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import prisma from "@/lib/db";
import { getSuperadminEmail } from "@/lib/config";
import { canonicalizeEmail } from "@/lib/email";
import { getAuthTrustedOrigins } from "@/lib/runtime-config";
import {
  AUTH_COOKIE_PREFIX,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
} from "./constants";
import {
  consumePortalAdmissionForUser,
  findPendingPortalAdmission,
} from "@/lib/admission/auth-claim";
import { logLogin, logPortalAdmissionEvent } from "@/lib/audit/logger";
import { getGoogleOAuthConfig } from "./provider-config";
import {
  getMcpResourceUrl,
  isMcpEnabled,
  MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  MCP_AUTH_SCOPES,
  MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
  MCP_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS,
} from "@/lib/mcp/config";
import { fetchCimdClientMetadataResource } from "@/lib/auth/cimd-fetch";
import { hashMcpOAuthToken } from "@/lib/mcp/token-storage";

const appEnv = process.env.APP_ENV;
const mockOAuthUrl = process.env.OAUTH_MOCK_URL?.trim();
const hasMockOAuth =
  Boolean(mockOAuthUrl) && (appEnv === "development" || appEnv === "test");
// OAuth-provider plugins seed their protected-resource model during startup.
// Unit tests that import auth through unrelated session helpers do not have a
// real adapter; dedicated auth tests opt in with the test-only flag below.
const hasMcpAuthPlugins =
  isMcpEnabled() &&
  (process.env.NODE_ENV !== "test" ||
    process.env.BESEDY_MCP_TEST_ENABLED === "true");
const mcpResourceUrl = hasMcpAuthPlugins ? getMcpResourceUrl() : null;

// Build social providers based on environment
const socialProviders: BetterAuthOptions["socialProviders"] = {};
const googleOAuthConfig = getGoogleOAuthConfig();
if (googleOAuthConfig) {
  socialProviders.google = {
    clientId: googleOAuthConfig.clientId,
    clientSecret: googleOAuthConfig.clientSecret,
    // Force account chooser to avoid silent reuse of a wrong Google account.
    prompt: "select_account",
  };
}

export const auth = betterAuth({
  // Base URL for constructing callback URLs
  baseURL: process.env.AUTH_URL,

  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  // Email/password disabled - OAuth only
  emailAndPassword: {
    enabled: false,
  },

  // Social providers (Google)
  socialProviders,

  // Account linking: allows existing users to link additional OAuth accounts
  account: {
    // In dev/test mock OAuth we do not need token refresh persistence.
    // Skipping account updates keeps local sign-in resilient with seeded test data.
    updateAccountOnSignIn: hasMockOAuth ? false : true,
    accountLinking: {
      enabled: true,
      trustedProviders: hasMockOAuth
        ? ["google", "mock-oauth"]
        : ["google"],
    },
  },

  // Plugins
  plugins: [
    ...(hasMockOAuth
      ? [
          genericOAuth({
            config: [
              {
                providerId: "mock-oauth",
                accountIssuer: "local:oauth:mock-oauth",
                accountSubject: ({ profile }) => {
                  if (typeof profile.sub !== "string" || profile.sub.length === 0) {
                    throw new Error("Mock OAuth profile is missing a subject");
                  }
                  return profile.sub;
                },
                clientId: "test-client-id",
                clientSecret: "test-client-secret",
                authorizationUrl: `${process.env.AUTH_URL || "http://localhost:3001"}/mock-oauth/authorize`,
                tokenUrl: `${mockOAuthUrl}/token`,
                userInfoUrl: `${mockOAuthUrl}/userinfo`,
                scopes: ["openid", "email", "profile"],
                // oauth2-mock-server uses OIDC-style claim names (sub, picture).
                // Better Auth expects id/image fields for provider profiles.
                mapProfileToUser: (profile: Record<string, unknown>) => ({
                  email: typeof profile.email === "string" ? profile.email : undefined,
                  name: typeof profile.name === "string" ? profile.name : undefined,
                  image: typeof profile.picture === "string" ? profile.picture : undefined,
                  emailVerified:
                    typeof profile.email_verified === "boolean"
                      ? profile.email_verified
                      : undefined,
                }),
              },
            ],
          }),
        ]
      : []),
    ...(mcpResourceUrl
      ? [
          jwt(),
          mcp({
            loginPage: "/auth/mcp-signin",
            consentPage: "/auth/mcp-consent",
            resource: mcpResourceUrl,
            // MCP 2026-07-28 prefers CIMD, while clients such as Claude still
            // require RFC 7591 DCR. Registration creates only an OAuth client
            // identity; PKCE, user consent, scopes, and live Besedy
            // authorization remain mandatory before any data is returned.
            allowDynamicClientRegistration: true,
            allowUnauthenticatedClientRegistration: true,
            clientRegistrationRequirePKCE: true,
            resources: [
              {
                identifier: mcpResourceUrl,
                name: "Besedy MCP",
                allowedScopes: [...MCP_AUTH_SCOPES],
              },
            ],
            scopes: [...MCP_AUTH_SCOPES],
            accessTokenExpiresIn: MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
            refreshTokenExpiresIn: MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
            refreshTokenReuseInterval:
              MCP_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS,
            // Keep token persistence and the refresh lock's lookup in sync.
            storeTokens: { hash: hashMcpOAuthToken },
            allowPublicClientPrelogin: true,
          }),
          cimd({
            fetchClientMetadataResource: fetchCimdClientMetadataResource,
            metadataProfile: "mcp-2026-07-28",
          }),
        ]
      : []),
    nextCookies(), // Must be last - handles cookie setting in server actions
  ],

  // User configuration with custom fields
  user: {
    additionalFields: {
      status: {
        type: "string",
        required: false,
        defaultValue: "PENDING",
      },
      isSuperadmin: {
        type: "boolean",
        required: false,
        defaultValue: false,
      },
      isAdmin: {
        type: "boolean",
        required: false,
        defaultValue: false,
      },
      invitedById: {
        type: "string",
        required: false,
      },
      invitedAt: {
        type: "date",
        required: false,
      },
      activatedAt: {
        type: "date",
        required: false,
      },
      lastLoginAt: {
        type: "date",
        required: false,
      },
    },
  },

  // Session configuration
  session: {
    expiresIn: SESSION_EXPIRES_IN_SECONDS, // 6 months
    updateAge: SESSION_UPDATE_AGE_SECONDS, // 7 days
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes
    },
  },

  // Advanced configuration
  advanced: {
    cookiePrefix: AUTH_COOKIE_PREFIX,
  },

  // Trusted origins for CORS
  trustedOrigins: getAuthTrustedOrigins(),

  // Database hooks for portal-admission allowlist enforcement.
  // Users are only created when they authenticate via OAuth.
  // They must have a pending portal admission unless they are the
  // configured superadmin bootstrap account.
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!user.email) {
            throw new APIError("BAD_REQUEST", {
              message: "Email is required",
            });
          }

          // Canonicalize email for consistent matching
          // This handles Gmail dot-insensitivity (john.doe@gmail.com = johndoe@gmail.com)
          const canonicalEmail = canonicalizeEmail(user.email);

          // Transform user email to canonical form before storage
          user.email = canonicalEmail;

          // Allow superadmin email (configured in besedy.toml) to sign up without
          // a pending portal admission.
          // This is the bootstrap mechanism for the first admin user
          const superadminEmail = getSuperadminEmail();
          if (superadminEmail && canonicalEmail === canonicalizeEmail(superadminEmail)) {
            (user as Record<string, unknown>).status = "ACTIVE";
            (user as Record<string, unknown>).isSuperadmin = true;
            (user as Record<string, unknown>).activatedAt = new Date();
            return;
          }

          const admission = await findPendingPortalAdmission(canonicalEmail);

          if (!admission) {
            throw new APIError("FORBIDDEN", {
              message: `not_authorized:${canonicalEmail}`,
            });
          }

          (user as Record<string, unknown>).invitedById = admission.admittedById;
          (user as Record<string, unknown>).invitedAt = admission.admittedAt;
        },
        after: async (user) => {
          let claim:
            | {
                portalAdmissionId: string | null;
                grants: Array<{
                  catalogId: string;
                  accessLevel: string;
                  grantedById: string | null;
                  notes: string | null;
                }>;
              }
            | null = null;

          const claimResult = await consumePortalAdmissionForUser(user);
          if (claimResult) {
            claim = claimResult;
          }

          if (!claim) {
            // Superadmin bootstrap intentionally bypasses pending-admission claim.
            const createdUser = await prisma.user.findUnique({
              where: { id: user.id },
              select: { email: true, isSuperadmin: true },
            });

            if (createdUser?.isSuperadmin) {
              return;
            }

            // Claim failed after pre-check (e.g. concurrent consume/revoke).
            // Remove the just-created user to avoid leaving an authenticated
            // account without a valid pending-admission claim.
            await prisma.user.delete({ where: { id: user.id } }).catch((err) =>
              console.error("[auth] Failed to roll back user after admission claim miss:", err)
            );

            throw new APIError("FORBIDDEN", {
              message: `not_authorized:${createdUser?.email ?? user.email ?? "unknown"}`,
            });
          }

          // Log audit event
          const primaryGrant = claim.grants[0] ?? null;
          await logPortalAdmissionEvent({
            actorId: user.id,
            action: "PORTAL_ADMISSION_CLAIMED",
            resourceId: claim.portalAdmissionId ?? user.email ?? user.id,
            email: user.email ?? "unknown",
            catalogId: primaryGrant?.catalogId ?? null,
            details: {
              email: user.email ?? "unknown",
              portalAdmissionId: claim.portalAdmissionId,
              pendingGrantCount: claim.grants.length,
              catalogId: primaryGrant?.catalogId ?? null,
              accessLevel: primaryGrant?.accessLevel ?? null,
              grants: claim.grants,
            },
          }).catch((err) => console.error("[auth] Failed to log portal admission claim:", err));
        },
      },
    },
    session: {
      create: {
        after: async (session) => {
          // Log login for audit trail and update lastLoginAt
          // Note: Runs async after session created - don't await to not block login
          prisma.user
            .update({
              where: { id: session.userId },
              data: { lastLoginAt: new Date() },
            })
            .catch((err) => console.error("[auth] Failed to update lastLoginAt:", err));

          // Log to audit log (non-blocking)
          logLogin(session.userId).catch((err) =>
            console.error("[auth] Failed to log login:", err)
          );
        },
      },
    },
  },

  // Disable default rate limiting (we handle it in proxy)
  rateLimit: {
    enabled: false,
  },
});

// Re-export types
export type { Session, User } from "better-auth/types";
