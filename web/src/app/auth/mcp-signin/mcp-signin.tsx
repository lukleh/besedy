"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle, Loader2 } from "lucide-react";
import { signInForMcpAuthorization } from "@/lib/auth/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function McpSignIn({ hasMockOAuth }: { hasMockOAuth: boolean }) {
  const searchParams = useSearchParams();
  const hasSignedRequest =
    searchParams.has("client_id") && searchParams.has("sig");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setLoading(true);
    setError(null);
    try {
      const result = await signInForMcpAuthorization(hasMockOAuth);
      if (result.error) {
        setError(result.error.message ?? "Could not start Google sign-in");
        setLoading(false);
      }
    } catch {
      setError("Could not start Google sign-in");
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>Connect to Besedy</CardTitle>
          <CardDescription>
            Sign in with your Besedy Google account to continue the MCP
            connection.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!hasSignedRequest && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                This authorization request is missing or invalid. Start the
                connection again from your MCP client.
              </AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button
            className="w-full"
            variant="outline"
            disabled={!hasSignedRequest || loading}
            onClick={handleSignIn}
          >
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Sign in with {hasMockOAuth ? "Mock OAuth" : "Google"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
