import { auth } from "@/lib/auth";

export async function GET(request: Request): Promise<Response> {
  return auth.handler(request);
}

export async function HEAD(request: Request): Promise<Response> {
  return auth.handler(request);
}
