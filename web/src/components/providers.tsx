"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";

import { TextSizeProvider } from "@/contexts/text-size-context";
import { RadioModeProvider } from "@/contexts/radio-mode-context";
import { AudioPlaybackProvider } from "@/contexts/audio-playback-context";
import { ServiceWorkerProvider } from "@/contexts/service-worker-context";
import { ReloadSafetyProvider } from "@/contexts/reload-safety-context";
import { DownloadManagerBridge } from "@/components/offline/download-manager-bridge";
import { useLabsSyncListener } from "@/hooks/use-labs";
import { isDownloadsShellWarmup } from "@/lib/offline/downloads-shell";
import { QUERY_CLIENT_DEFAULT_OPTIONS } from "@/lib/query/profiles";

function LabsSyncListener() {
  useLabsSyncListener();
  return null;
}

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
      <LabsSyncListener />
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
        nonce={nonce}
      >
        <TextSizeProvider>
          <RadioModeProvider>
            <ReloadSafetyProvider>
              <AudioPlaybackProvider>
                <ServiceWorkerProvider passive={isWarmup}>
                  {!isWarmup && <DownloadManagerBridge />}
                  {children}
                </ServiceWorkerProvider>
              </AudioPlaybackProvider>
            </ReloadSafetyProvider>
          </RadioModeProvider>
        </TextSizeProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
