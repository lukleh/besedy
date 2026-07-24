import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { routing } from "./routing";

export default getRequestConfig(async () => {
  // Try to get locale from cookie first
  const cookieStore = await cookies();
  const localeCookie = cookieStore.get("NEXT_LOCALE")?.value;

  // Validate cookie value
  let locale = routing.defaultLocale;
  if (localeCookie && routing.locales.includes(localeCookie as typeof routing.locales[number])) {
    locale = localeCookie as typeof routing.locales[number];
  } else {
    // Try to detect from Accept-Language header
    const headersList = await headers();
    const acceptLanguage = headersList.get("accept-language");
    if (acceptLanguage) {
      // Parse accept-language header (e.g., "cs,en-US;q=0.9,en;q=0.8")
      const languages = acceptLanguage.split(",").map((lang) => {
        const [code] = lang.trim().split(";");
        return code.split("-")[0]; // Get just the language code
      });

      // Find first matching locale
      for (const lang of languages) {
        if (routing.locales.includes(lang as typeof routing.locales[number])) {
          locale = lang as typeof routing.locales[number];
          break;
        }
      }
    }
  }

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    timeZone: "Europe/Prague",
  };
});
