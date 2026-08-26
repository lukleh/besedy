import type { UserStatus } from '@/generated/prisma/client';
import prisma from '@/lib/db';
import type { SystemRole } from '@/lib/policy/actor';

export interface McpIdentity {
  userId: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  status: UserStatus;
  systemRole: SystemRole;
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
        emailVerified: true,
        status: true,
        isAdmin: true,
        isSuperadmin: true,
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
    emailVerified: user.emailVerified,
    status: user.status,
    systemRole: user.isSuperadmin
      ? 'SUPERADMIN'
      : user.isAdmin
        ? 'ADMIN'
        : 'USER',
    clientId,
    clientName: client?.name ?? null,
  };
}
