import { Prisma } from "@/generated/prisma/client";

/**
 * Convert an optional value to a shape Prisma accepts for a nullable Json column.
 * Using `Prisma.DbNull` clears the column to SQL NULL. Callers that need to
 * persist a literal JSON `null` should pass `Prisma.JsonNull` explicitly.
 */
export function toPrismaJson(
  value: unknown
): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
  if (value === null || value === undefined) {
    return Prisma.DbNull;
  }

  return value as Prisma.InputJsonValue;
}
