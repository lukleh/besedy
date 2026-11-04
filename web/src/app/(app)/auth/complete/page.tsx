import { headers } from "next/headers";
import { redirect } from "next/navigation";
import AuthCompleteClient from "./auth-complete-client";
import { resolveRequestAuthFromHeaders } from "@/lib/auth/request-auth";
import {
  getAllowlistRejectionParam,
  sanitizePostAuthCallbackPath,
} from "@/lib/auth/oauth-routing";
import { getFirstSearchParamValue, type PageSearchParams as SearchParams } from "@/lib/navigation/search-params";

type AuthCompletePageProps = {
  searchParams?: Promise<SearchParams>;
};

export default async function AuthCompletePage({ searchParams }: AuthCompletePageProps) {
  const resolvedSearchParams = await searchParams;
  const error = getFirstSearchParamValue(resolvedSearchParams?.error) ?? null;
  const errorDescription =
    getFirstSearchParamValue(resolvedSearchParams?.error_description) ?? null;
  const state = getFirstSearchParamValue(resolvedSearchParams?.state) ?? null;
  const callbackUrl = sanitizePostAuthCallbackPath(
    getFirstSearchParamValue(resolvedSearchParams?.callbackUrl)
  );
  const allowlistRejection = getAllowlistRejectionParam(error, errorDescription);

  if (allowlistRejection) {
    redirect(`/auth/unauthorized?error=${encodeURIComponent(allowlistRejection)}`);
  }

  const authResult = await resolveRequestAuthFromHeaders(await headers(), {
    surface: "server",
  });

  if (authResult.authenticated) {
    redirect(callbackUrl);
  }

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex min-h-[80vh] flex-col items-center justify-center py-8">
      <AuthCompleteClient
        callbackUrl={callbackUrl}
        error={error}
        errorDescription={errorDescription}
        state={state}
      />
    </div>
  );
}
