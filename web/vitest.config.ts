import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    unstubEnvs: true,
    setupFiles: ["./tests/setup.ts"],
    exclude: ["tests/e2e/**"],
    // Booting jsdom per test file dominated the run, so only component tests
    // (.tsx) get it by default. A .ts test of browser behaviour opts in with a
    // `@vitest-environment jsdom` docblock. Without it `document`, `window` and
    // `localStorage` are undefined: most DOM use throws, but code that checks
    // `typeof window` quietly takes its server branch, so add the docblock
    // whenever the test is about the browser path.
    projects: [
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["tests/unit/**/*.{test,spec}.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/unit/**/*.{test,spec}.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "./coverage",
      exclude: [
        "node_modules/",
        "tests/",
        "**/*.d.ts",
        "src/generated/",
        "src/components/ui/**", // Shadcn components
      ],
      include: ["src/**/*.{ts,tsx}"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
