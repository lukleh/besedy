import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { Geist, Geist_Mono } from 'next/font/google';
import { getLocale, getMessages, getTimeZone } from 'next-intl/server';
import { Toaster } from 'sonner';
import '../globals.css';
import { AppProviders } from '@/components/app-providers';
import { GoogleTranslateWarning } from '@/components/google-translate-warning';
import { MobileToastOverlay } from '@/components/mobile-toast-overlay';
import { OfflineBanner } from '@/components/offline-banner';
import { UpdateBanner } from '@/components/update-banner';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Besedy Downloads',
  description: 'Listen to downloaded Besedy recordings without a connection',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Besedy',
  },
  other: {
    google: 'notranslate',
    'mobile-web-app-capable': 'yes',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

/**
 * Session-free root for the device-local Downloads experience.
 *
 * The proxy still requires an authenticated request while online. Once this
 * shell is cached, it can start without consulting the server and reads only
 * the device-local download registry and payload store.
 */
export default async function OfflineRootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();
  const timeZone = await getTimeZone();
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      translate="no"
      className="notranslate"
    >
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <AppProviders
          locale={locale}
          messages={messages}
          timeZone={timeZone}
          initialSession={null}
          nonce={nonce}
        >
          <GoogleTranslateWarning />
          <main className="min-h-screen pb-16">{children}</main>
          <Toaster richColors position="top-right" />
          <MobileToastOverlay />
          <OfflineBanner />
          <UpdateBanner />
        </AppProviders>
      </body>
    </html>
  );
}
