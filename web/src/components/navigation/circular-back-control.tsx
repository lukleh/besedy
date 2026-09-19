import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

const circularBackClassName =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-foreground text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

interface CircularBackLinkProps {
  href: string;
  label: string;
  className?: string;
  testId?: string;
}

export function CircularBackLink({
  href,
  label,
  className,
  testId,
}: CircularBackLinkProps) {
  return (
    <Link
      href={href}
      className={cn(circularBackClassName, className)}
      aria-label={label}
      title={label}
      data-testid={testId}
    >
      <ArrowLeft className="h-6 w-6" aria-hidden="true" />
    </Link>
  );
}

interface CircularBackButtonProps {
  label: string;
  onClick: () => void;
  className?: string;
  testId?: string;
}

export function CircularBackButton({
  label,
  onClick,
  className,
  testId,
}: CircularBackButtonProps) {
  return (
    <button
      type="button"
      className={cn(circularBackClassName, className)}
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
    >
      <ArrowLeft className="h-6 w-6" aria-hidden="true" />
    </button>
  );
}
