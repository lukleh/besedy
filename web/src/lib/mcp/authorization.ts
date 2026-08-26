import prisma from '@/lib/db';
import { MCP_READ_SCOPE } from '@/lib/mcp/config';

interface McpAuthorizationIdentity {
  clientId: string;
  resourceUrl: string;
  tokenScopes: string[];
  userId: string;
}

export interface ActiveMcpAuthorization {
  scopes: string[];
}

export async function getActiveMcpAuthorization({
  clientId,
  resourceUrl,
  tokenScopes,
  userId,
}: McpAuthorizationIdentity): Promise<ActiveMcpAuthorization | null> {
  const client = await prisma.oauthClient.findUnique({
    where: { clientId },
    select: {
      disabled: true,
      skipConsent: true,
      resources: {
        where: { resourceId: resourceUrl },
        select: {
          resource: { select: { disabled: true } },
        },
      },
      consents: {
        where: { userId },
        select: { scopes: true },
        orderBy: { updatedAt: 'desc' },
        take: 1,
      },
    },
  });

  if (
    !client ||
    client.disabled === true ||
    !client.resources.some(({ resource }) => resource.disabled !== true)
  ) {
    return null;
  }

  const liveConsentScopes = client.consents[0]?.scopes ?? [];
  const scopes = client.skipConsent
    ? tokenScopes
    : tokenScopes.filter((scope) => liveConsentScopes.includes(scope));

  return scopes.includes(MCP_READ_SCOPE) ? { scopes } : null;
}
