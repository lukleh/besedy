'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertCircle, Loader2 } from 'lucide-react';
import { respondToMcpConsent } from '@/lib/auth/client';
import { useValidatedMcpAuthorizationRequest } from '@/app/auth/use-validated-mcp-authorization-request';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export default function McpConsent() {
  const searchParams = useSearchParams();
  const clientId = searchParams.get('client_id');
  const oauthQuery = searchParams.toString();
  const scopes = (searchParams.get('scope') ?? '')
    .split(/\s+/)
    .filter(
      (scope) => scope && scope !== 'openid' && scope !== 'offline_access',
    );
  const { requestValidation, validatedClient } =
    useValidatedMcpAuthorizationRequest(
      clientId,
      oauthQuery,
      searchParams.has('sig'),
    );
  const [pendingChoice, setPendingChoice] = useState<'accept' | 'deny' | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  async function choose(accept: boolean) {
    setPendingChoice(accept ? 'accept' : 'deny');
    setError(null);
    try {
      const result = await respondToMcpConsent(accept);
      if (result.error) {
        setError(result.error.message ?? 'Could not complete authorization');
        setPendingChoice(null);
      }
    } catch {
      setError('Could not complete authorization');
      setPendingChoice(null);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Allow access to Besedy?</CardTitle>
          <CardDescription className="break-all">
            {validatedClient?.client_name ??
              validatedClient?.client_id ??
              'Validating MCP client'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {requestValidation === 'validating' && (
            <Alert>
              <Loader2 className="h-4 w-4 animate-spin" />
              <AlertDescription>
                Verifying the authorization request…
              </AlertDescription>
            </Alert>
          )}
          {requestValidation === 'invalid' && (
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
          {requestValidation === 'valid' && (
            <div className="space-y-2 text-sm">
              <p>This client will be able to:</p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>
                  List released events and published recordings in catalogs you
                  can access.
                </li>
                <li>
                  Read and search transcripts for those published recordings.
                </li>
                {scopes.map((scope) => (
                  <li key={scope}>Request scope: {scope}</li>
                ))}
              </ul>
              <p className="text-muted-foreground">
                Audio and Besedy mutations are not exposed by this MCP server.
              </p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={requestValidation !== 'valid' || pendingChoice !== null}
              onClick={() => choose(false)}
            >
              {pendingChoice === 'deny' && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Deny
            </Button>
            <Button
              disabled={requestValidation !== 'valid' || pendingChoice !== null}
              onClick={() => choose(true)}
            >
              {pendingChoice === 'accept' && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Allow
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
