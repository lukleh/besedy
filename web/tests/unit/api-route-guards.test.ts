import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The proxy does not authenticate API requests, so the handler's own guard is
// the only one. This keeps a route from shipping without one. A guard here
// refuses at least a signed-out caller; what a signed-in caller may do is each
// route's own check, which this test does not see. It checks each route file
// as a whole, not each exported method, and ignores comments.
const srcDir = path.join(__dirname, "..", "..", "src");
const apiDir = path.join(srcDir, "app", "api");

const GUARDS = [
  "requireAuth",
  "requireAdminCapability",
  "requireCatalogManagementAccess",
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

// Routes whose handlers are built elsewhere: the route has to import the named
// handlers, the module has to export them, and the module has to call a guard.
const ADMIN_PENDING = "lib/admission/admin-pending-record-route.ts";
const CATALOG_PENDING = "lib/admission/catalog-pending-record-route.ts";
const CRUD_FACTORY = "lib/api/crud-factory.ts";
const DELEGATED: Record<string, { module: string; handlers: string[] }> = {
  "admin/portal-admissions/[email]": {
    module: ADMIN_PENDING,
    handlers: ["getAdminPendingRecord", "patchAdminPendingRecord", "deleteAdminPendingRecord"],
  },
  "catalogs/[id]/pending-catalog-grants/[email]": {
    module: CATALOG_PENDING,
    handlers: ["deletePendingCatalogRecord", "updatePendingCatalogRecord"],
  },
  "catalogs/[id]/metadata/albums": { module: CRUD_FACTORY, handlers: ["albumCollectionHandlers"] },
  "catalogs/[id]/metadata/albums/[itemId]": { module: CRUD_FACTORY, handlers: ["albumItemHandlers"] },
  "catalogs/[id]/metadata/locations": {
    module: CRUD_FACTORY,
    handlers: ["locationCollectionHandlers"],
  },
  "catalogs/[id]/metadata/locations/[itemId]": {
    module: CRUD_FACTORY,
    handlers: ["locationItemHandlers"],
  },
  "catalogs/[id]/metadata/recorders": {
    module: CRUD_FACTORY,
    handlers: ["recorderCollectionHandlers"],
  },
  "catalogs/[id]/metadata/recorders/[itemId]": {
    module: CRUD_FACTORY,
    handlers: ["recorderItemHandlers"],
  },
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
  "[[...notFound]]": "answers every unknown API path, and /api itself, with 404",
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

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function callsGuard(source: string): boolean {
  return GUARDS.some((guard) => new RegExp(`\\b${guard}\\(`).test(source));
}

function readSource(file: string): string {
  return withoutComments(readFileSync(file, "utf8"));
}

const routes = routeFiles(apiDir).map((file) => ({
  name: routeName(file),
  source: readSource(file),
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
    for (const [name, { module, handlers }] of Object.entries(DELEGATED)) {
      const route = routes.find((candidate) => candidate.name === name);
      expect(route, name).toBeDefined();

      const moduleSource = readSource(path.join(srcDir, module));
      for (const handler of handlers) {
        const imported = new RegExp(`import\\s*\\{[^}]*\\b${handler}\\b[^}]*\\}\\s*from`);
        const exported = new RegExp(`export\\s+(?:async\\s+function|const)\\s+${handler}\\b`);
        expect(imported.test(route!.source), `${name} imports ${handler}`).toBe(true);
        expect(exported.test(moduleSource), `${module} exports ${handler}`).toBe(true);
      }

      expect(callsGuard(moduleSource), module).toBe(true);
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
