import type { McpAccessProfile } from '@/lib/mcp/access-profile';

export interface BesedyMcpRequestContext {
  clientId: string;
  clientName: string | null;
  scopes: string[];
  accessProfile: McpAccessProfile;
}
