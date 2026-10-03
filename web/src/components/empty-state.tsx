import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface EmptyStateProps extends Omit<ComponentProps<"div">, "title" | "children" | "className"> {
  icon: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons or links shown under the description. */
  actions?: ReactNode;
}

/**
 * The centered icon, heading, description and actions block of a page that has
 * nothing to show: not found, a failed load, an empty list.
 */
export function EmptyState({ icon: Icon, title, description, actions, ...props }: EmptyStateProps) {
  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 pb-6 sm:pt-6" {...props}>
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Icon className="h-12 w-12 text-muted-foreground mb-4" />
        <h1 className="text-lg font-semibold">{title}</h1>
        {description ? (
          <p className="text-sm text-muted-foreground mt-2 max-w-md">{description}</p>
        ) : null}
        {actions ? (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}
