'use client';

import { useEffect, useState } from 'react';
import {
  validateMcpAuthorizationRequest,
  type McpOAuthClientMetadata,
} from '@/lib/auth/client';

export type McpRequestValidation = 'validating' | 'valid' | 'invalid';

interface ValidationResult {
  client: McpOAuthClientMetadata | null;
  requestKey: string;
  status: Exclude<McpRequestValidation, 'validating'>;
}

export function useValidatedMcpAuthorizationRequest(
  clientId: string | null,
  oauthQuery: string,
  hasSignature: boolean,
): {
  requestValidation: McpRequestValidation;
  validatedClient: McpOAuthClientMetadata | null;
} {
  const requestKey =
    clientId && hasSignature ? `${clientId}\u0000${oauthQuery}` : null;
  const [result, setResult] = useState<ValidationResult | null>(null);

  useEffect(() => {
    if (!clientId || !requestKey) return;

    const controller = new AbortController();
    void validateMcpAuthorizationRequest(
      clientId,
      oauthQuery,
      controller.signal,
    )
      .then((metadata) => {
        if (!controller.signal.aborted) {
          setResult({ client: metadata, requestKey, status: 'valid' });
        }
      })
      .catch((validationError: unknown) => {
        if (
          validationError instanceof DOMException &&
          validationError.name === 'AbortError'
        ) {
          return;
        }
        if (!controller.signal.aborted) {
          setResult({ client: null, requestKey, status: 'invalid' });
        }
      });

    return () => controller.abort();
  }, [clientId, oauthQuery, requestKey]);

  if (!requestKey) {
    return { requestValidation: 'invalid', validatedClient: null };
  }
  if (!result || result.requestKey !== requestKey) {
    return { requestValidation: 'validating', validatedClient: null };
  }

  return {
    requestValidation: result.status,
    validatedClient: result.client,
  };
}
