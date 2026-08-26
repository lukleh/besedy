import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getMcpAccessProfile } from "@/lib/mcp/access-profile";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export async function createBesedyMcpServer(
  userId: string
): Promise<McpServer> {
  const profile = await getMcpAccessProfile(userId);
  const server = new McpServer({
    name: "besedy",
    version: "0.1.0",
  });

  if (!profile.canEnterPortal) {
    return server;
  }

  server.registerTool(
    "list_catalogs",
    {
      title: "List Besedy catalogs",
      description:
        "List the catalogs available to the current user and the read capabilities allowed in each catalog.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => {
      const result = { catalogs: profile.catalogs };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }
  );

  // Further tools are registered here only when the aggregate profile permits
  // them. Their handlers must still authorize the resolved target catalog.
  // This first vertical slice intentionally ships catalog discovery before the
  // event/transcript/search service extraction is complete.

  return server;
}
