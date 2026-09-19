"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportClientError } from "@/lib/client-error-reporting";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error to console for debugging
    console.error("Application error:", error);

    // Send error to backend for logging
    reportClientError({
      message: error.message,
      stack: error.stack,
      digest: error.digest,
      source: "error-boundary",
    });
  }, [error]);

  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center gap-4 p-8">
      <AlertTriangle className="h-12 w-12 text-destructive" />
      <h2 className="text-xl font-semibold">Something went wrong</h2>
      <p className="text-center text-muted-foreground max-w-md">
        An unexpected error occurred. Please try again or refresh the page.
      </p>
      {process.env.NEXT_PUBLIC_APP_ENV === "development" && (
        <pre className="mt-4 max-w-full overflow-auto rounded bg-muted p-4 text-xs">
          {error.message}
        </pre>
      )}
      <div className="flex gap-2">
        <Button onClick={reset} variant="outline">
          <RefreshCw className="mr-2 h-4 w-4" />
          Try again
        </Button>
        <Button onClick={() => window.location.reload()}>
          Refresh page
        </Button>
      </div>
    </div>
  );
}
