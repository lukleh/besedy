import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  // Supported locales
  locales: ["en", "cs"],

  // Default locale when no locale is specified
  defaultLocale: "en",

  // Show locale prefix only when not the default
  localePrefix: "as-needed",
});

// Type-safe locale type
export type Locale = (typeof routing.locales)[number];
