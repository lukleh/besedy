import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ResponsiveMenu,
  ResponsiveMenuCheckboxItem,
  ResponsiveMenuContent,
  ResponsiveMenuTrigger,
} from "@/components/ui/responsive-menu";

vi.mock("@/hooks/use-media-query", () => ({ useIsDesktop: () => true }));

function renderMenu(closeOnSelect?: boolean) {
  const onOpenChange = vi.fn();
  const onCheckedChange = vi.fn();
  render(
    <ResponsiveMenu open onOpenChange={onOpenChange}>
      <ResponsiveMenuTrigger asChild>
        <button type="button">Options</button>
      </ResponsiveMenuTrigger>
      <ResponsiveMenuContent>
        <ResponsiveMenuCheckboxItem
          checked={false}
          onCheckedChange={onCheckedChange}
          closeOnSelect={closeOnSelect}
        >
          Timestamps
        </ResponsiveMenuCheckboxItem>
      </ResponsiveMenuContent>
    </ResponsiveMenu>,
  );
  // The menu closes itself on mount and on route changes; only the click counts.
  onOpenChange.mockClear();
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Timestamps" }));
  return { onOpenChange, onCheckedChange };
}

describe("ResponsiveMenuCheckboxItem on desktop", () => {
  it("closes the dropdown after a toggle by default", () => {
    const { onOpenChange, onCheckedChange } = renderMenu();

    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays open for ticking several options when asked to", () => {
    const { onOpenChange, onCheckedChange } = renderMenu(false);

    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
