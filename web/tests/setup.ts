import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, vi, beforeAll } from "vitest";

// Unit tests must not depend on the operator's shell. Clear every variable the
// web env templates define (including commented-out optional ones) before any
// test module loads, so a sourced env file such as web.env.prod cannot change
// results. Tests that need a value set it with vi.stubEnv.
for (const template of [".env.dev.example", ".env.test.example", ".env.prod.example"]) {
  const text = readFileSync(path.join(__dirname, "..", template), "utf8");
  for (const [, name] of text.matchAll(/^#?[ \t]*([A-Z][A-Z0-9_]*)=/gm)) {
    delete process.env[name];
  }
}

// Set up environment variables before any imports
beforeAll(() => {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.AUTH_SECRET = "test-secret-for-unit-tests";
});

// Mock Prisma client
vi.mock("@/lib/db", () => ({
  default: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    groupMembership: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    permissionGroup: {
      findUnique: vi.fn(),
    },
    groupCatalogAccess: {
      findMany: vi.fn(),
    },
    workflowGroup: {
      findMany: vi.fn(),
    },
    audioMetadata: {
      findUnique: vi.fn(),
    },
  },
}));

// Mock auth session
vi.mock("@/lib/auth/session", () => ({
  auth: vi.fn(() => Promise.resolve(null)),
}));

// Cleanup after each test
afterEach(() => {
  cleanup();
});

const usePathnameMock = vi.fn(() => "/");

// Mock Next.js router
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: usePathnameMock,
}));

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};
Object.defineProperty(window, "localStorage", { value: localStorageMock });

// Mock ResizeObserver (required for Radix UI components)
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
