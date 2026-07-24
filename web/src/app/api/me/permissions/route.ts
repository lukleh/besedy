import { NextResponse } from "next/server";
import {
  AuthError,
  requireAuth,
} from "@/lib/auth/permissions";
import { getAdminCapability } from "@/lib/access/capabilities";

export const dynamic = "force-dynamic";

/**
 * GET /api/me/permissions
 * Returns the current user's admin permissions for client-side rendering
 */
export async function GET() {
  try {
    const userId = await requireAuth();
    const capability = await getAdminCapability(userId);

    return NextResponse.json({
      isSuperadmin: capability.isSuperadmin,
      isAdmin: capability.isAdmin,
      canAccessAdmin: capability.canAccessAdmin,
      hasEditorOnAnyCatalog: capability.hasEditorOnAnyCatalog,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error fetching permissions:", error);
    return NextResponse.json(
      { error: "Failed to fetch permissions" },
      { status: 500 }
    );
  }
}
