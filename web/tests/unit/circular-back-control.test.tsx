import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CircularBackButton,
  CircularBackLink,
} from "@/components/navigation/circular-back-control";

describe("circular back controls", () => {
  it("renders the shared circular link treatment", () => {
    render(<CircularBackLink href="/catalog" label="Back to catalog" />);

    const link = screen.getByRole("link", { name: "Back to catalog" });
    expect(link).toHaveAttribute("href", "/catalog");
    expect(link).toHaveClass("h-9", "w-9", "rounded-full", "border-2");
    expect(link.querySelector(".lucide-arrow-left")).toBeInTheDocument();
  });

  it("renders the same treatment for client-side back actions", () => {
    const onClick = vi.fn();
    render(<CircularBackButton label="Back to downloads" onClick={onClick} />);

    const button = screen.getByRole("button", { name: "Back to downloads" });
    expect(button).toHaveClass("h-9", "w-9", "rounded-full", "border-2");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
