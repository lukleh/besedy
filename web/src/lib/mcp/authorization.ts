import prisma from '@/lib/db';
import { MCP_READ_SCOPE } from '@/lib/mcp/config';

interface McpAuthorizationIdentity {
  clientId: string;
  resourceUrl: string;
  userId: string;
}

export async function hasActiveMcpAuthorization({
  clientId,
  resourceUrl,
  userId,
}: McpAuthorizationIdentity): Promise<boolean> {
  const consent = await prisma.oauthConsent.findFirst({
    where: {
      clientId,
      userId,
      scopes: { has: MCP_READ_SCOPE },
      resources: { has: resourceUrl },
      client: {
        disabled: false,
        resources: {
          some: {
            resourceId: resourceUrl,
            resource: { disabled: false },
          },
        },
      },
    },
    select: { id: true },
  });

  return consent !== null;
}
