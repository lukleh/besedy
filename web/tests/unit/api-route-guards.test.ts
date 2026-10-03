import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The proxy does not authenticate API requests, so the handler's own guard is
// the only one. This keeps a route from shipping without
// one. It checks each route file as a whole, not each exported method.
const srcDir = path.join(__dirname, "..", "..", "src");
const apiDir = path.join(srcDir, "app", "api");

const GUARDS = [
  "requireAuth",
  "requireAdminCapability",
  "requireCatalogManagementAccess",
  "resolveCatalogManagementActor",
  "requireCatalogEventsAccess",
  "requireEventArtworkAccess",
  "requireCorrectionAccess",
  "resolveCatalogRecordingRouteAccess",
  "resolveTranscriptRouteAccess",
  "authorizeCatalogDeepSearch",
  "authorizeCatalogDeepSearchRead",
  "authorizeDeepSearchServiceRequest",
  "authorizeJobServiceRequest",
  "requireMcpAuth",
];

// Routes whose handlers are built elsewhere: the module named here has to call
// a guard instead.
const DELEGATED: Record<string, string> = {
  "admin/portal-admissions/[email]": "lib/admission/admin-pending-record-route.ts",
  "catalogs/[id]/pending-catalog-grants/[email]": "lib/admission/catalog-pending-record-route.ts",
  "metadata/albums": "lib/api/crud-factory.ts",
  "metadata/albums/[id]": "lib/api/crud-factory.ts",
  "metadata/artists": "lib/api/crud-factory.ts",
  "metadata/duplicate-counts": "lib/api/crud-factory.ts",
  "metadata/locations": "lib/api/crud-factory.ts",
  "metadata/locations/[id]": "lib/api/crud-factory.ts",
  "metadata/recorders": "lib/api/crud-factory.ts",
  "metadata/recorders/[id]": "lib/api/crud-factory.ts",
};

// Routes that refuse by hand rather than through a guard helper.
// `getCatalogCapability` is not a guard: it reports access and refuses nobody.
const CHECKED_IN_HANDLER: Record<string, string> = {
  "catalogs/[id]/status": "checks getCurrentUserId and capability.hasAccess",
  "catalogs/[id]/random-event": "checks getCurrentUserId and capability.hasAccess",
};

// Routes that are open on purpose.
const PUBLIC: Record<string, string> = {
  health: "liveness probe; listed in the proxy's public API routes",
  version: "deployed revision; listed in the proxy's public API routes",
  "csp-report": "browsers post CSP violations without credentials",
  "csp-report/client-error": "client error reports, also from signed-out pages",
  "web-update-events": "service-worker update telemetry, also from signed-out pages",
  "auth/[...all]": "Better Auth's own endpoints",
  "auth-complete/session": "finishes sign-in, before a session exists",
  "[...notFound]": "answers every unknown API path with 404",
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === "route.ts" ? [full] : [];
  });
}

function routeName(file: string): string {
  return path.relative(apiDir, path.dirname(file)).split(path.sep).join("/");
}

function callsGuard(source: string): boolean {
  return GUARDS.some((guard) => new RegExp(`\\b${guard}\\(`).test(source));
}

const routes = routeFiles(apiDir).map((file) => ({
  name: routeName(file),
  source: readFileSync(file, "utf8"),
}));

describe("API route guards", () => {
  it("finds the API routes", () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it("guards every route that is not listed", () => {
    const unguarded = routes
      .filter(
        ({ name }) => !(name in PUBLIC) && !(name in DELEGATED) && !(name in CHECKED_IN_HANDLER)
      )
      .filter(({ source }) => !callsGuard(source))
      .map(({ name }) => name);

    // Call a guard from the new route, or list it above with a reason.
    expect(unguarded).toEqual([]);
  });

  it("guards the modules that delegated routes import", () => {
    for (const [name, module] of Object.entries(DELEGATED)) {
      const route = routes.find((candidate) => candidate.name === name);
      expect(route, name).toBeDefined();

      // Either the module itself or its directory's index re-export.
      const importPath = module.replace(/\.ts$/, "");
      const importsModule =
        route!.source.includes(`"@/${importPath}"`) ||
        route!.source.includes(`"@/${path.posix.dirname(importPath)}"`);
      expect(importsModule, `${name} imports ${module}`).toBe(true);

      expect(callsGuard(readFileSync(path.join(srcDir, module), "utf8")), module).toBe(true);
    }
  });

  it("lists only routes that exist", () => {
    const names = new Set(routes.map(({ name }) => name));
    const stale = [
      ...Object.keys(PUBLIC),
      ...Object.keys(DELEGATED),
      ...Object.keys(CHECKED_IN_HANDLER),
    ].filter(
      (name) => !names.has(name)
    );

    expect(stale).toEqual([]);
  });
});
