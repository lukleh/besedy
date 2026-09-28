import { notFound } from "next/navigation";

// The app has two root layouts, so Next.js has no app-wide page for unmatched
// URLs. Catching them here renders (app)/not-found.tsx inside the app shell.
export default function UnmatchedRoute() {
  notFound();
}
