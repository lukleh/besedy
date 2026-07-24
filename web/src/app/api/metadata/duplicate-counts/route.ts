import { NextRequest } from "next/server";
import { duplicateCountsHandler } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return duplicateCountsHandler.GET(request);
}
