import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateRequestBody, conflict, notFound, handlePrismaError } from "@/lib/api";
import { EmailSchema } from "@/lib/validation/schemas";
import {
  PortalAdmissionNotClaimedError,
  PortalAdmissionNotFoundError,
  PortalAdmissionUserStillExistsError,
  resetClaimedPortalAdmission,
} from "@/lib/admission/admin-reset";
import { logPortalAdmissionEvent } from "@/lib/audit/logger";
import { requireAdminCapability } from "@/lib/access/require-admin";

export const dynamic = "force-dynamic";

const ResetPortalAdmissionSchema = z.object({
  email: EmailSchema,
});

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireAdminCapability({
      message: "Admin access required to reset portal admissions",
    });

    const bodyResult = await validateRequestBody(request, ResetPortalAdmissionSchema);
    if (!bodyResult.success) return bodyResult.response;
    const { email } = bodyResult.data;

    const result = await resetClaimedPortalAdmission(email, userId);

    await logPortalAdmissionEvent({
      actorId: userId,
      action: "PORTAL_ADMISSION_RESET",
      resourceId: result.portalAdmissionId,
      email: result.email,
      details: {
        email: result.email,
        pendingGrantCount: result.pendingGrantCount,
        reopenedGrants: result.reopenedGrants,
      },
    });

    return NextResponse.json({
      success: true,
      email: result.email,
      pendingGrantCount: result.pendingGrantCount,
      reopenedGrants: result.reopenedGrants,
    });
  } catch (error) {
    if (error instanceof PortalAdmissionNotFoundError) {
      return notFound("portal admission");
    }
    if (error instanceof PortalAdmissionNotClaimedError) {
      return conflict("Only claimed portal admissions can be reset");
    }
    if (error instanceof PortalAdmissionUserStillExistsError) {
      return conflict("Delete the existing user before resetting portal admission");
    }
    return handlePrismaError(error, "portal admission", "update");
  }
}
