import type { McpOAuthClientMetadata } from '@/lib/auth/client';

export function getMcpClientMetadataOrigin(clientId: string): string | null {
  try {
    const url = new URL(clientId);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function McpClientIdentity({
  client,
}: {
  client: McpOAuthClientMetadata;
}) {
  const origin = getMcpClientMetadataOrigin(client.client_id);

  return (
    <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
      <p className="font-medium break-words">
        {client.client_name ?? 'Unnamed MCP client'}
      </p>
      <p className="break-all text-xs text-muted-foreground">
        Client ID: {client.client_id}
      </p>
      {origin ? (
        <p className="break-all text-xs text-muted-foreground">
          Client metadata origin: {origin}
        </p>
      ) : (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Dynamically registered client; its displayed name is not verified by a
          web origin.
        </p>
      )}
    </div>
  );
}
