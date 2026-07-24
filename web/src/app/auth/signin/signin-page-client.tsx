"use client";

import dynamic from "next/dynamic";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function SignInFormSkeleton() {
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <Skeleton className="mx-auto h-8 w-48" />
        <Skeleton className="mx-auto mt-2 h-4 w-64" />
      </CardHeader>
      <CardContent className="space-y-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </CardContent>
    </Card>
  );
}

// Dynamic import with ssr: false to prevent SSR crashes when providers aren't ready
const SignInForm = dynamic(() => import("./signin-form"), {
  ssr: false,
  loading: () => <SignInFormSkeleton />,
});

type SignInPageClientProps = {
  hasMockOAuth: boolean;
};

export default function SignInPageClient({ hasMockOAuth }: SignInPageClientProps) {
  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex min-h-[80vh] flex-col items-center justify-center py-8">
      <SignInForm hasMockOAuth={hasMockOAuth} />
    </div>
  );
}
