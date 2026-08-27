import type { McpAccessProfile } from '@/lib/mcp/access-profile';

export interface BesedyMcpRequestContext {
  clientId: string;
  scopes: string[];
  accessProfile: McpAccessProfile;
}
