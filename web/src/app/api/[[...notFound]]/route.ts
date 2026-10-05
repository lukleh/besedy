import { notFound } from "@/lib/api";

// Unknown API paths answer with the same JSON 404 as the API routes, instead
// of falling through to the app's not-found page.
function handler() {
  return notFound("API route");
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
