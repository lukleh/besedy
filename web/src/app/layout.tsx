import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { getLocale, getMessages, getTimeZone } from "next-intl/server";
import "./globals.css";
import { AppProviders } from "@/components/app-providers";
import { Header } from "@/components/header";
import { GoogleTranslateWarning } from "@/components/google-translate-warning";
import { OfflineBanner } from "@/components/offline-banner";
import { InstallBanner } from "@/components/pwa/install-banner";
import { RadioBanner } from "@/components/radio/radio-banner";
import { RadioSpacer } from "@/components/radio/radio-spacer";
import { UpdateBanner } from "@/components/update-banner";
import { MobileToastOverlay } from "@/components/mobile-toast-overlay";
import { getSession } from "@/lib/auth/session";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Besedy - Audio Catalog Browser",
  description:
    "Browse audio catalogs, play recordings, and view synchronized transcripts",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Besedy",
  },
  other: {
    google: "notranslate",
    "mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();
  const timeZone = await getTimeZone();
  // Fetch session server-side to prevent client hydration mismatch
  // This ensures the Header shows correct auth state from first render
  const session = await getSession();
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang={locale} suppressHydrationWarning translate="no" className="notranslate">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <AppProviders
          locale={locale}
          messages={messages}
          timeZone={timeZone}
          initialSession={session}
          nonce={nonce}
        >
          <GoogleTranslateWarning />
          <div className="relative flex min-h-screen flex-col">
            <Header />
            {/* Spacer for fixed header */}
            <div className="h-14 safe-top" aria-hidden="true" />
            <RadioSpacer />
            <main className="flex-1">{children}</main>
          </div>
          <Toaster richColors position="top-right" />
          <MobileToastOverlay />
          <RadioBanner />
          <InstallBanner />
          <OfflineBanner />
          <UpdateBanner />
        </AppProviders>
      </body>
    </html>
  );
}
