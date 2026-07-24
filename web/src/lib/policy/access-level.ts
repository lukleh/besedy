import type { AccessLevel } from "@/generated/prisma/client";

const ACCESS_LEVEL_ORDER: AccessLevel[] = [
  "LISTENER",
  "VIEWER",
  "MEMBER",
  "EDITOR",
  "OWNER",
];

export function accessLevelAtLeast(
  level: AccessLevel,
  required: AccessLevel
): boolean {
  return (
    ACCESS_LEVEL_ORDER.indexOf(level) >= ACCESS_LEVEL_ORDER.indexOf(required)
  );
}
