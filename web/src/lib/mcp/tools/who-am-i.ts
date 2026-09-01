import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { MCP_EMAIL_SCOPE, MCP_PROFILE_SCOPE } from '@/lib/mcp/config';
import { getMcpIdentity } from '@/lib/mcp/identity';
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  registerBesedyTool,
  toolError,
  toolSuccess,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';
import { WhoAmIOutputSchema } from '@/lib/mcp/tools/output-schemas';

export function registerWhoAmITool(
  server: McpServer,
  context: BesedyMcpRequestContext,
): void {
  const { clientId, scopes, accessProfile: profile } = context;
  registerBesedyTool(
    server,
    context,
    'who_am_i',
    {
      title: 'Show current Besedy identity',
      description:
        'Show the account, OAuth client, scopes, and default catalog for this connection. Use it only to diagnose identity or access.',
      inputSchema: z.object({}),
      outputSchema: WhoAmIOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async () => {
      const identity = await getMcpIdentity(profile.userId, clientId);
      if (!identity) {
        return toolError(
          'identity_unavailable',
          'The authenticated Besedy account is no longer available',
        );
      }

      const canReadProfile = scopes.includes(MCP_PROFILE_SCOPE);
      const canReadEmail = scopes.includes(MCP_EMAIL_SCOPE);
      const result = {
        account: {
          id: identity.userId,
          name: canReadProfile ? identity.name : null,
          email: canReadEmail ? identity.email : null,
          emailVerified: canReadEmail ? identity.emailVerified : null,
          status: canReadProfile ? profile.userStatus : null,
          systemRole: canReadProfile ? profile.systemRole : null,
        },
        authorization: {
          clientId: identity.clientId,
          clientName: identity.clientName,
          grantedScopes: scopes,
          accessibleCatalogCount: profile.catalogs.length,
          defaultCatalogId: profile.defaultCatalogId,
        },
      };
      const accountLabel =
        result.account.email ?? result.account.name ?? identity.userId;
      const roleLabel = canReadProfile ? ` (${profile.systemRole})` : '';
      const summary = `Connected to Besedy as ${accountLabel}${roleLabel} via ${identity.clientName ?? identity.clientId}.`;
      return toolSuccess(result, summary);
    },
  );
}
