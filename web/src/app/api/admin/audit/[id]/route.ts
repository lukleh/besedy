import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import {
  isAdmin,
  isSuperadmin,
} from "@/lib/auth/permissions";
import { requireAdminCapability } from "@/lib/access/require-admin";
import { mapAuditLogToDetailViewModel } from "@/lib/audit/model";

export const dynamic = "force-dynamic";

const LEGACY_AUDIT_RESOURCE = "invitation";

// Types for related entities
interface RelatedEntity {
  type:
    | "user"
    | "audio"
    | "catalog"
    | "catalog_access"
    | "portal_admission"
    | "pending_catalog_grant";
  found: boolean;
  data: unknown;
  error?: string;
}

function isAuthError(error: unknown): error is { message: string; statusCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    "message" in error &&
    typeof (error as { statusCode: unknown }).statusCode === "number" &&
    typeof (error as { message: unknown }).message === "string"
  );
}

/**
 * Fetch related entity based on resource type and resourceId
 */
async function fetchRelatedEntity(
  resource: string,
  resourceId: string | null
): Promise<RelatedEntity | null> {
  if (!resourceId) return null;

  try {
    switch (resource) {
      case "user":
      case "auth": {
        // resourceId is a user ID
        const user = await prisma.user.findUnique({
          where: { id: resourceId },
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            status: true,
            isSuperadmin: true,
            isAdmin: true,
            lastLoginAt: true,
            createdAt: true,
            catalogAccess: {
              where: { status: "ACTIVE" },
              select: {
                id: true,
                catalogId: true,
                accessLevel: true,
                catalog: {
                  select: { id: true, label: true },
                },
              },
            },
          },
        });

        return {
          type: "user",
          found: !!user,
          data: user,
        };
      }

      case "audio":
      case "transcript":
      case "metadata": {
        // resourceId is an audio hash (SHA-256)
        // First try to get curated metadata from database
        const audioMetadata = await prisma.audioMetadata.findFirst({
          where: { audioHash: resourceId },
          include: {
            album: true,
            recorder: true,
            location: true,
            workflowGroup: {
              select: { id: true, label: true },
            },
          },
        });

        if (audioMetadata) {
          // Try to get CSV entry data
          let csvEntry = null;
          try {
            const { getFullCatalogEntry } = await import("@/lib/catalog");
            const fullEntry = await getFullCatalogEntry(
              audioMetadata.workflowGroupId,
              resourceId
            );
            if (fullEntry) {
              // Extract extension from filename
              const filename = fullEntry.fullMetadata?.Filename || "";
              const extension = filename.split(".").pop() || "";
              // Parse file size from bytes string
              const sizeBytes = parseInt(fullEntry.fullMetadata?.["Size (bytes)"] || "0", 10);
              const fileSizeMb = sizeBytes / (1024 * 1024);

              csvEntry = {
                source_path: fullEntry.fullArchived?.["Original Path"] || fullEntry.fullMetadata?.["Full Path"] || "",
                duration_hms: fullEntry.fullMetadata?.Duration || fullEntry.fullArchived?.Duration || "",
                extension,
                file_size_mb: fileSizeMb,
              };
            }
          } catch {
            // CSV loading failed, continue with database data only
          }

          return {
            type: "audio",
            found: true,
            data: {
              hash: resourceId,
              entry: csvEntry || {
                source_path: "",
                duration_hms: "",
                extension: "",
                file_size_mb: 0,
              },
              sourceMetadata: {
                title: audioMetadata.title,
                artist: audioMetadata.artist,
                album: audioMetadata.album?.name,
                verified: audioMetadata.verified,
                dateYear: audioMetadata.dateYear,
                dateMonth: audioMetadata.dateMonth,
                dateDay: audioMetadata.dateDay,
                notes: audioMetadata.notes,
                tags: audioMetadata.tags,
                recorder: audioMetadata.recorder?.name,
                location: audioMetadata.location?.name,
              },
              workflowGroup: audioMetadata.workflowGroup,
            },
          };
        }

        // No curated metadata, try to find in any active catalog
        const activeGroup = await prisma.workflowGroup.findFirst({
          where: { isActive: true },
          orderBy: { isDefault: "desc" },
        });

        if (activeGroup) {
          try {
            const { getFullCatalogEntry } = await import("@/lib/catalog");
            const fullEntry = await getFullCatalogEntry(activeGroup.id, resourceId);
            if (fullEntry) {
              // Extract extension from filename
              const filename = fullEntry.fullMetadata?.Filename || "";
              const extension = filename.split(".").pop() || "";
              // Parse file size from bytes string
              const sizeBytes = parseInt(fullEntry.fullMetadata?.["Size (bytes)"] || "0", 10);
              const fileSizeMb = sizeBytes / (1024 * 1024);

              return {
                type: "audio",
                found: true,
                data: {
                  hash: resourceId,
                  entry: {
                    source_path: fullEntry.fullArchived?.["Original Path"] || fullEntry.fullMetadata?.["Full Path"] || "",
                    duration_hms: fullEntry.fullMetadata?.Duration || fullEntry.fullArchived?.Duration || "",
                    extension,
                    file_size_mb: fileSizeMb,
                  },
                  sourceMetadata: fullEntry.fullMetadata
                    ? {
                        title: fullEntry.fullMetadata.title,
                        artist: fullEntry.fullMetadata.artist,
                        album: fullEntry.fullMetadata.album,
                        verified: false, // CSV doesn't have verified field
                      }
                    : null,
                  workflowGroup: { id: activeGroup.id, label: activeGroup.label },
                },
              };
            }
          } catch {
            // CSV loading failed
          }
        }

        return {
          type: "audio",
          found: false,
          data: null,
          error: "Audio not found in any catalog",
        };
      }

      case "catalog": {
        // resourceId is a workflow group ID
        const catalog = await prisma.workflowGroup.findUnique({
          where: { id: resourceId },
          select: {
            id: true,
            label: true,
            isDefault: true,
            isActive: true,
            createdAt: true,
          },
        });

        return {
          type: "catalog",
          found: !!catalog,
          data: catalog,
        };
      }

      case "catalog_access": {
        // resourceId can be:
        // - A CatalogAccess ID (CUID)
        // - A composite key "userId:catalogId"
        let access = null;

        // First try as direct ID
        access = await prisma.catalogAccess.findUnique({
          where: { id: resourceId },
          select: {
            id: true,
            accessLevel: true,
            status: true,
            createdAt: true,
            revokedAt: true,
            user: {
              select: { id: true, name: true, email: true },
            },
            catalog: {
              select: { id: true, label: true },
            },
            grantedBy: {
              select: { id: true, name: true, email: true },
            },
          },
        });

        // If not found, try parsing as composite key
        if (!access && resourceId.includes(":")) {
          const [userId, catalogId] = resourceId.split(":");
          if (userId && catalogId) {
            access = await prisma.catalogAccess.findFirst({
              where: { userId, catalogId },
              select: {
                id: true,
                accessLevel: true,
                status: true,
                createdAt: true,
                revokedAt: true,
                user: {
                  select: { id: true, name: true, email: true },
                },
                catalog: {
                  select: { id: true, label: true },
                },
                grantedBy: {
                  select: { id: true, name: true, email: true },
                },
              },
            });
          }
        }

        return {
          type: "catalog_access",
          found: !!access,
          data: access,
        };
      }

      case "portal_admission": {
        const admissionSelect = {
          id: true,
          email: true,
          source: true,
          status: true,
          revocationReason: true,
          admittedAt: true,
          claimedAt: true,
          revokedAt: true,
          notes: true,
          admittedBy: {
            select: { id: true, name: true, email: true },
          },
          claimedBy: {
            select: { id: true, name: true, email: true },
          },
          revokedBy: {
            select: { id: true, name: true, email: true },
          },
        } as const;

        let admission = await prisma.portalAdmission.findUnique({
          where: { id: resourceId },
          select: admissionSelect,
        });

        if (!admission) {
          admission = await prisma.portalAdmission.findUnique({
            where: { email: resourceId },
            select: admissionSelect,
          });
        }

        return {
          type: "portal_admission",
          found: !!admission,
          data: admission,
        };
      }

      case "pending_catalog_grant": {
        const grantSelect = {
          id: true,
          email: true,
          catalogId: true,
          accessLevel: true,
          status: true,
          grantedAt: true,
          consumedAt: true,
          revokedAt: true,
          notes: true,
          catalog: {
            select: { id: true, label: true },
          },
          grantedBy: {
            select: { id: true, name: true, email: true },
          },
          consumedBy: {
            select: { id: true, name: true, email: true },
          },
          revokedBy: {
            select: { id: true, name: true, email: true },
          },
        } as const;

        let grant = await prisma.pendingCatalogGrant.findUnique({
          where: { id: resourceId },
          select: grantSelect,
        });

        if (!grant && resourceId.includes(":")) {
          const [email, catalogId] = resourceId.split(":");
          if (email && catalogId) {
            grant = await prisma.pendingCatalogGrant.findUnique({
              where: {
                email_catalogId: {
                  email,
                  catalogId,
                },
              },
              select: grantSelect,
            });
          }
        }

        return {
          type: "pending_catalog_grant",
          found: !!grant,
          data: grant,
        };
      }

      default:
        return null;
    }
  } catch (error) {
    console.error(`Error fetching related entity for ${resource}:`, error);
    return {
      type: resource as RelatedEntity["type"],
      found: false,
      data: null,
      error: "Failed to load related entity",
    };
  }
}

/**
 * GET /api/admin/audit/:id - Get single audit log entry
 * Query params:
 *   - expand: boolean - if true, include related entity data
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId: currentUserId } = await requireAdminCapability({
      message: "Admin access required",
    });

    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const expand = searchParams.get("expand") === "true";

    const isSuperAdmin = await isSuperadmin();
    const isAdminUser = await isAdmin();

    const log = await prisma.auditLog.findFirst({
      where: {
        id,
        resource: { not: LEGACY_AUDIT_RESOURCE },
        domain: { not: null },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
    });

    if (!log) {
      return NextResponse.json(
        { error: "Audit log entry not found" },
        { status: 404 }
      );
    }

    // Superadmins and admins can see all logs, others only their own
    const canViewAllLogs = isSuperAdmin || isAdminUser;
    if (!canViewAllLogs && log.userId !== currentUserId) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // If expand is requested, fetch related entity
    let relatedEntity: RelatedEntity | null = null;
    if (expand) {
      relatedEntity = await fetchRelatedEntity(log.resource, log.resourceId);
    }

    return NextResponse.json(mapAuditLogToDetailViewModel(log, relatedEntity));
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error fetching audit log:", error);
    return NextResponse.json(
      { error: "Failed to fetch audit log" },
      { status: 500 }
    );
  }
}
