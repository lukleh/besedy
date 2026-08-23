import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/version - Get deployment version information
 * Public endpoint (no auth required) for health checks and debugging
 */
export async function GET(request: NextRequest) {
  const gitCommit = process.env.GIT_COMMIT || "unknown";
  const webVersion = process.env.WEB_VERSION || gitCommit;
  const buildTime = process.env.BUILD_TIME || null;
  const appEnv = process.env.APP_ENV || "development";
  const etag = `"${webVersion}"`;

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch === etag) {
    const response = new NextResponse(null, { status: 304 });
    response.headers.set("Cache-Control", "no-cache, must-revalidate");
    response.headers.set("ETag", etag);
    return response;
  }

  const response = NextResponse.json({
    commit: gitCommit,
    commitShort: gitCommit.slice(0, 7),
    webVersion,
    buildTime,
    environment: appEnv,
  });
  response.headers.set("Cache-Control", "no-cache, must-revalidate");
  response.headers.set("ETag", etag);
  return response;
}
