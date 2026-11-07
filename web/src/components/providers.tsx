"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";

import { TextSizeProvider } from "@/contexts/text-size-context";
import { AudioPlaybackProvider } from "@/contexts/audio-playback-context";
import { SleepTimerProvider } from "@/contexts/sleep-timer-context";
import { ServiceWorkerProvider } from "@/contexts/service-worker-context";
import { ReloadSafetyProvider } from "@/contexts/reload-safety-context";
import { CorrectionDraftsProvider } from "@/contexts/correction-drafts-context";
import { DownloadManagerBridge } from "@/components/offline/download-manager-bridge";
import { isDownloadsShellWarmup } from "@/lib/offline/downloads-shell";
import { QUERY_CLIENT_DEFAULT_OPTIONS } from "@/lib/query/profiles";

export function Providers({
  children,
  nonce,
}: {
  children: React.ReactNode;
  nonce?: string;
}) {
  const isWarmup = isDownloadsShellWarmup();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: QUERY_CLIENT_DEFAULT_OPTIONS,
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
        nonce={nonce}
      >
        <TextSizeProvider>
          <ReloadSafetyProvider>
            <CorrectionDraftsProvider>
              <AudioPlaybackProvider>
                <SleepTimerProvider>
                  <ServiceWorkerProvider passive={isWarmup}>
                    {!isWarmup && <DownloadManagerBridge />}
                    {children}
                  </ServiceWorkerProvider>
                </SleepTimerProvider>
              </AudioPlaybackProvider>
            </CorrectionDraftsProvider>
          </ReloadSafetyProvider>
        </TextSizeProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
