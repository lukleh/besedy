import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CatalogSearchBar } from "@/components/catalog/catalog-search-bar";

describe("CatalogSearchBar", () => {
  it("submits the form and clears the current value", () => {
    const onSubmit = vi.fn();
    const onClear = vi.fn();

    render(
      <CatalogSearchBar
        value="Praha"
        onChange={vi.fn()}
        placeholder="Search events"
        ariaLabel="Search events"
        onSubmit={onSubmit}
        onClear={onClear}
        clearLabel="Clear search"
        submitLabel="Search"
        inputTestId="catalog-search-input"
      />,
    );

    fireEvent.submit(
      screen.getByTestId("catalog-search-input").closest("form")!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("shows the optional back control", () => {
    render(
      <CatalogSearchBar
        value="Praha"
        onChange={vi.fn()}
        placeholder="Search events"
        ariaLabel="Search events"
        onSubmit={vi.fn()}
        onClear={vi.fn()}
        clearLabel="Clear search"
        submitLabel="Search"
        showBackButton
        onBack={vi.fn()}
        backLabel="Back"
      />,
    );

    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });
});
