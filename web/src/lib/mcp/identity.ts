import prisma from '@/lib/db';

export interface McpIdentity {
  userId: string;
  name: string | null;
  email: string | null;
  clientId: string;
  clientName: string | null;
}

export async function getMcpIdentity(
  userId: string,
  clientId: string,
): Promise<McpIdentity | null> {
  const [user, client] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
      },
    }),
    prisma.oauthClient.findUnique({
      where: { clientId },
      select: { name: true },
    }),
  ]);

  if (!user) return null;

  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    clientId,
    clientName: client?.name ?? null,
  };
}
