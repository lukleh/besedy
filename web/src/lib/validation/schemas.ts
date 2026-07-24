import { z } from "zod";
import { canonicalizeEmail } from "../email";

/**
 * Zod validation schemas for API request validation.
 *
 * These schemas provide type-safe validation for all API endpoints,
 * preventing malformed input from reaching business logic.
 */

// =============================================================================
// Common Patterns
// =============================================================================

/**
 * SHA-256 hash (64 hexadecimal characters)
 * Used for audio content hashes throughout the system.
 */
export const HashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, "Invalid SHA-256 hash format (expected 64 hex characters)");

/**
 * CUID - Collision-resistant unique identifier
 * Used for database IDs (catalogs, etc.)
 */
export const CuidSchema = z
  .string()
  .regex(/^c[a-z0-9]{24,}$/i, "Invalid CUID format");

/**
 * User ID - better-auth generates 32-character alphanumeric IDs
 * Used for user database IDs
 */
export const UserIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9]{20,}$/, "Invalid user ID format");

/**
 * Timestamp ID format (YYYYMMDD_HHMMSS)
 * Used for workflow group IDs
 */
export const TimestampIdSchema = z
  .string()
  .regex(/^\d{8}_\d{6}$/, "Invalid timestamp ID format (expected YYYYMMDD_HHMMSS)");

/**
 * Email address (canonicalized for consistent storage and lookup)
 *
 * Applies canonicalization:
 * - Trims whitespace
 * - Lowercases
 * - Gmail: removes dots and +suffix, normalizes googlemail.com
 */
export const EmailSchema = z
  .string()
  .transform((s) => s.trim()) // Trim before validation (spaces fail .email())
  .pipe(z.string().email("Invalid email address"))
  .transform(canonicalizeEmail);

// =============================================================================
// Route Param Schemas (for use with validateParams)
// =============================================================================

/**
 * Route params with CUID id
 */
export const CuidParamSchema = z.object({ id: CuidSchema });

/**
 * Route params with user id (better-auth format)
 */
export const UserIdParamSchema = z.object({ id: UserIdSchema });

/**
 * Route params with timestamp id (YYYYMMDD_HHMMSS)
 */
export const TimestampIdParamSchema = z.object({ id: TimestampIdSchema });

/**
 * Route params with hash
 */
export const HashParamSchema = z.object({ hash: HashSchema });

/**
 * Route params with catalog id and hash (for nested routes)
 */
export const CatalogHashParamSchema = z.object({
  id: TimestampIdSchema,
  hash: HashSchema,
});

/**
 * Route params with catalog id and user id (for access routes)
 */
export const CatalogUserParamSchema = z.object({
  id: TimestampIdSchema,
  userId: UserIdSchema,
});

// =============================================================================
// Access Control
// =============================================================================

/**
 * Catalog access levels (hierarchical)
 */
export const AccessLevelSchema = z.enum(["LISTENER", "VIEWER", "MEMBER", "EDITOR", "OWNER"]);
export type AccessLevel = z.infer<typeof AccessLevelSchema>;

/**
 * Catalog access status (for soft-delete support)
 */
export const AccessStatusSchema = z.enum(["ACTIVE", "REVOKED"]);
export type AccessStatus = z.infer<typeof AccessStatusSchema>;

/**
 * User account status
 * Note: PENDING is kept for legacy rows; pending onboarding is represented
 * by unclaimed portal admissions.
 */
export const UserStatusSchema = z.enum(["ACTIVE", "PENDING", "BLOCKED"]);
export type UserStatus = z.infer<typeof UserStatusSchema>;

/**
 * Mutable user statuses exposed via admin user update APIs.
 * PENDING is portal-admission semantics and not assignable to existing users.
 */
export const MutableUserStatusSchema = z.enum(["ACTIVE", "BLOCKED"]);
export type MutableUserStatus = z.infer<typeof MutableUserStatusSchema>;

// =============================================================================
// Transcript
// =============================================================================

/**
 * Transcript backend key: "{workflow}/{model_component}"
 */
export const TranscriptBackendSchema = z
  .string()
  .min(3)
  .refine((value) => {
    const parts = value.split("/");
    if (parts.length !== 2) return false;
    const [workflow, model] = parts;
    if (!workflow || !model) return false;
    if (workflow === "." || workflow === ".." || model === "." || model === "..") return false;
    if (workflow.includes("\\") || model.includes("\\")) return false;
    return true;
  }, "Invalid transcript backend key");
export type TranscriptBackend = z.infer<typeof TranscriptBackendSchema>;

/**
 * Diarization backends
 */
export const DiarizationBackendSchema = z.enum(["pyannote"]);
export type DiarizationBackend = z.infer<typeof DiarizationBackendSchema>;

/**
 * Transcript download formats
 */
export const TranscriptFormatSchema = z.enum(["json", "txt", "srt", "vtt"]);
export type TranscriptFormat = z.infer<typeof TranscriptFormatSchema>;

/**
 * Transcript backend priority update (admin).
 */
export const TranscriptBackendPriorityUpdateSchema = z.object({
  backend: TranscriptBackendSchema,
  priority: z.number().int().nullable(),
});
export const TranscriptBackendPriorityPayloadSchema = z.object({
  updates: z.array(TranscriptBackendPriorityUpdateSchema),
});

// =============================================================================
// Audio API
// =============================================================================

/**
 * Audio source selection
 */
export const AudioSourceSchema = z.enum(["archived", "listening", "original"]);
export type AudioSource = z.infer<typeof AudioSourceSchema>;

/**
 * Audio route query parameters
 */
export const AudioQuerySchema = z.object({
  group: z.string().optional(),
  source: AudioSourceSchema.optional().default("archived"),
  variant: z.string().optional(),
  download: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
});

// =============================================================================
// Catalog Access Management
// =============================================================================

/**
 * Grant access to a catalog
 */
export const GrantAccessSchema = z.object({
  userId: UserIdSchema,
  accessLevel: AccessLevelSchema,
  notes: z.string().max(500).optional(),
  userName: z.string().min(1).max(100).optional(),
});

/**
 * Update catalog access
 */
export const UpdateAccessSchema = z.object({
  accessLevel: AccessLevelSchema,
  notes: z.string().max(500).optional(),
});

/**
 * Update catalog access with optional user name editing
 */
export const UpdateAccessWithNameSchema = z.object({
  accessLevel: AccessLevelSchema,
  notes: z.string().max(500).optional(),
  userName: z.string().min(1).max(100).optional(),
});

/**
 * Restore revoked catalog access
 */
export const RestoreAccessSchema = z.object({
  action: z.literal("restore"),
});

/**
 * User search for catalog access grant dialog
 */
export const UserSearchQuerySchema = z.object({
  search: z.string().max(100).optional(),
});

/**
 * Create pending catalog grant (from the catalog settings route)
 */
export const CreatePendingCatalogGrantSchema = z.object({
  email: EmailSchema,
  accessLevel: AccessLevelSchema,
  message: z.string().max(500).optional(),
});

// =============================================================================
// User Management
// =============================================================================

/**
 * Update user status/role/name
 */
export const UpdateUserSchema = z.object({
  status: MutableUserStatusSchema.optional(),
  isAdmin: z.boolean().optional(),
  name: z.string().min(1).max(100).optional(),
});

/**
 * Update admin role
 */
export const UpdateAdminRoleSchema = z.object({
  isAdmin: z.boolean(),
});

/**
 * User list query params
 */
export const UserListQuerySchema = z.object({
  status: UserStatusSchema.optional(),
  search: z.string().max(100).optional(),
});

/**
 * Add user to the allowlist (admin creates pending admission state, not a user row)
 * Optionally assign catalog access at the same time
 */
export const AddUserSchema = z.object({
  email: EmailSchema,
  catalogId: TimestampIdSchema.optional(),
  accessLevel: AccessLevelSchema.optional(),
}).refine(
  (data) => {
    // If catalogId is provided, accessLevel must also be provided
    if (data.catalogId && !data.accessLevel) return false;
    // If accessLevel is provided, catalogId must also be provided
    if (data.accessLevel && !data.catalogId) return false;
    return true;
  },
  { message: "Both catalogId and accessLevel must be provided together" }
);

// =============================================================================
// Catalog Variants
// =============================================================================

/**
 * Create variant
 */
export const CreateVariantSchema = z.object({
  variant: z.string().min(1).max(50),
  label: z.string().max(100).optional(),
  listeningArchivedCatalogPath: z.string().max(500).optional(),
  isDefault: z.boolean().optional(),
});

/**
 * Update variant
 */
export const UpdateVariantSchema = z.object({
  label: z.string().max(100).optional(),
  listeningArchivedCatalogPath: z.string().max(500).optional(),
  isDefault: z.boolean().optional(),
});

// =============================================================================
// Catalog Management
// =============================================================================

/**
 * Catalog update
 */
export const UpdateCatalogSchema = z.object({
  label: z.string().max(100).optional(),
  description: z.string().max(1000).optional(),
  isActive: z.boolean().optional(),
  transcriptsPath: z.string().max(500).optional(),
});

/**
 * Create catalog from discovered group
 */
export const CreateCatalogSchema = z.object({
  groupId: TimestampIdSchema,
  label: z.string().max(100).optional(),
});

/**
 * Create full catalog (admin/superadmin)
 */
export const CreateFullCatalogSchema = z.object({
  id: TimestampIdSchema,
  label: z.string().max(100).optional(),
  archivedCatalogPath: z.string().min(1).max(500),
  metadataCatalogPath: z.string().min(1).max(500),
  transcriptsPath: z.string().max(500).optional(),
  isDefault: z.boolean().optional(),
});

// =============================================================================
// Recording Metadata
// =============================================================================

/**
 * Update recording metadata (user-editable fields)
 * Note: recorderId/locationId are Int in Prisma (autoincrement), not CUID
 */
export const UpdateRecordingMetadataSchema = z.object({
  title: z.string().max(200).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  recorderId: z.number().int().positive().optional().nullable(),
  locationId: z.number().int().positive().optional().nullable(),
  recordedAt: z.string().datetime().optional().nullable(),
});

// =============================================================================
// Enum Management
// =============================================================================

/**
 * Create recorder/location
 */
export const CreateEnumSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

/**
 * Update recorder/location
 */
export const UpdateEnumSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});

// =============================================================================
// User Preferences
// =============================================================================

/**
 * Update preferences
 */
export const UpdatePreferencesSchema = z.object({
  activeGroupId: CuidSchema.optional().nullable(),
  preferredBackend: TranscriptBackendSchema.optional().nullable(),
  theme: z.enum(["light", "dark", "system"]).optional(),
});

/**
 * Update audio source preference
 */
export const UpdateAudioSourceSchema = z.object({
  audioSource: AudioSourceSchema,
  variant: z.string().max(50).optional().nullable(),
});

// =============================================================================
// Pagination
// =============================================================================

/**
 * Standard pagination query params
 */
export const PaginationSchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 1))
    .pipe(z.number().int().min(1)),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 20))
    .pipe(z.number().int().min(1).max(100)),
});
