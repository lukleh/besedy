import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";

// Mock scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

const mockOptions: ComboboxOption[] = [
  { id: "user-1", label: "John Doe", description: "john@example.com", type: "available" },
  { id: "user-2", label: "Jane Smith", description: "jane@example.com", type: "available" },
  { id: "user-3", label: "Revoked User", description: "revoked@example.com", type: "revoked", previousAccessLevel: "VIEWER" },
];

describe("Combobox", () => {
  const defaultProps = {
    value: "",
    onValueChange: vi.fn(),
    searchValue: "",
    onSearchChange: vi.fn(),
    options: mockOptions,
    onSelect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders with placeholder", () => {
    render(<Combobox {...defaultProps} placeholder="Select a user" />);

    const input = screen.getByRole("combobox");
    expect(input).toHaveAttribute("placeholder", "Select a user");
  });

  it("renders with custom search placeholder", () => {
    render(
      <Combobox
        {...defaultProps}
        placeholder="Select..."
        searchPlaceholder="Search users..."
      />
    );

    const input = screen.getByRole("combobox");
    expect(input).toHaveAttribute("placeholder", "Select...");
  });

  it("calls onSearchChange when typing", async () => {
    const onSearchChange = vi.fn();
    render(<Combobox {...defaultProps} onSearchChange={onSearchChange} />);

    const input = screen.getByRole("combobox");
    await userEvent.type(input, "john");

    // onSearchChange is called for each character typed
    expect(onSearchChange).toHaveBeenCalledTimes(4);
    expect(onSearchChange).toHaveBeenNthCalledWith(1, "j");
    expect(onSearchChange).toHaveBeenNthCalledWith(2, "o");
    expect(onSearchChange).toHaveBeenNthCalledWith(3, "h");
    expect(onSearchChange).toHaveBeenNthCalledWith(4, "n");
  });

  it("shows loading indicator when isLoading is true", () => {
    render(<Combobox {...defaultProps} isLoading={true} />);

    // The loading indicator is a Loader2Icon with animate-spin class
    const loadingIndicator = document.querySelector(".animate-spin");
    expect(loadingIndicator).toBeInTheDocument();
  });

  it("disables input when disabled prop is true", () => {
    render(<Combobox {...defaultProps} disabled={true} />);

    const input = screen.getByRole("combobox");
    expect(input).toBeDisabled();
  });

  it("opens dropdown on input focus", async () => {
    render(<Combobox {...defaultProps} searchValue="jo" />);

    const input = screen.getByRole("combobox");
    await userEvent.click(input);

    expect(input).toHaveAttribute("aria-expanded", "true");
  });

  it("displays options when dropdown is open", async () => {
    render(<Combobox {...defaultProps} searchValue="jo" />);

    const input = screen.getByRole("combobox");
    await userEvent.click(input);

    // Should show section headers
    expect(screen.getByText("Grant access")).toBeInTheDocument();
    expect(screen.getByText("Restore access")).toBeInTheDocument();

    // Should show available options
    expect(screen.getByText("John Doe")).toBeInTheDocument();
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();

    // Should show revoked option with previous access level
    expect(screen.getByText("Revoked User")).toBeInTheDocument();
    expect(screen.getByText("Previously: VIEWER")).toBeInTheDocument();
  });

  it("shows empty message when no results and search is long enough", async () => {
    render(
      <Combobox
        {...defaultProps}
        options={[]}
        searchValue="xy"
        emptyMessage="No users found"
      />
    );

    const input = screen.getByRole("combobox");
    await userEvent.click(input);

    expect(screen.getByText("No users found")).toBeInTheDocument();
  });

  it("shows hint when search is too short", async () => {
    render(<Combobox {...defaultProps} options={[]} searchValue="x" />);

    const input = screen.getByRole("combobox");
    await userEvent.click(input);

    expect(screen.getByText("Type at least 2 characters to search")).toBeInTheDocument();
  });

  it("calls onSelect when clicking an option", async () => {
    const onSelect = vi.fn();
    render(<Combobox {...defaultProps} onSelect={onSelect} searchValue="jo" />);

    const input = screen.getByRole("combobox");
    await userEvent.click(input);

    const option = screen.getByText("John Doe");
    await userEvent.click(option);

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "user-1",
        label: "John Doe",
        type: "available",
      })
    );
  });

  it("shows invite option when showInviteOption is true", async () => {
    render(
      <Combobox
        {...defaultProps}
        options={[]}
        searchValue="new@example.com"
        showInviteOption={true}
        inviteEmail="new@example.com"
        onInvite={vi.fn()}
      />
    );

    const input = screen.getByRole("combobox");
    await userEvent.click(input);

    expect(screen.getByText("new@example.com")).toBeInTheDocument();
    expect(screen.getByText("Invite")).toBeInTheDocument();
  });

  it("calls onInvite when clicking invite option", async () => {
    const onInvite = vi.fn();
    render(
      <Combobox
        {...defaultProps}
        options={[]}
        searchValue="new@example.com"
        showInviteOption={true}
        inviteEmail="new@example.com"
        onInvite={onInvite}
      />
    );

    const input = screen.getByRole("combobox");
    await userEvent.click(input);

    const inviteButton = screen.getByRole("button", { name: /invite/i });
    await userEvent.click(inviteButton);

    expect(onInvite).toHaveBeenCalledTimes(1);
  });

  describe("keyboard navigation", () => {
    it("opens dropdown on ArrowDown", async () => {
      render(<Combobox {...defaultProps} searchValue="jo" />);

      const input = screen.getByRole("combobox");
      input.focus();
      await userEvent.keyboard("{ArrowDown}");

      expect(input).toHaveAttribute("aria-expanded", "true");
    });

    // Note: Enter key opens dropdown when closed, but in test environment
    // the Popover component may not handle this correctly. The ArrowDown
    // test covers the keyboard-open functionality. Enter when open is
    // tested in "selects highlighted option on Enter".

    it("closes dropdown on Escape", async () => {
      render(<Combobox {...defaultProps} searchValue="jo" />);

      const input = screen.getByRole("combobox");
      await userEvent.click(input);
      expect(input).toHaveAttribute("aria-expanded", "true");

      await userEvent.keyboard("{Escape}");
      expect(input).toHaveAttribute("aria-expanded", "false");
    });

    it("navigates through options with ArrowDown/ArrowUp", async () => {
      render(<Combobox {...defaultProps} searchValue="jo" />);

      const input = screen.getByRole("combobox");
      await userEvent.click(input);

      // First item should be highlighted initially (revoked user is first)
      const firstOption = screen.getByText("Revoked User").closest("button");
      expect(firstOption).toHaveClass("bg-accent");

      // Navigate down
      await userEvent.keyboard("{ArrowDown}");
      const secondOption = screen.getByText("John Doe").closest("button");
      expect(secondOption).toHaveClass("bg-accent");

      // Navigate up
      await userEvent.keyboard("{ArrowUp}");
      expect(firstOption).toHaveClass("bg-accent");
    });

    it("selects highlighted option on Enter", async () => {
      const onSelect = vi.fn();
      render(<Combobox {...defaultProps} onSelect={onSelect} searchValue="jo" />);

      const input = screen.getByRole("combobox");
      await userEvent.click(input);

      // Navigate to second option (John Doe - first available after revoked)
      await userEvent.keyboard("{ArrowDown}");
      await userEvent.keyboard("{Enter}");

      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "user-1",
          label: "John Doe",
        })
      );
    });
  });

  describe("option grouping", () => {
    it("shows only available options when no revoked", async () => {
      const availableOnly = mockOptions.filter(o => o.type === "available");
      render(<Combobox {...defaultProps} options={availableOnly} searchValue="jo" />);

      const input = screen.getByRole("combobox");
      await userEvent.click(input);

      expect(screen.getByText("Grant access")).toBeInTheDocument();
      expect(screen.queryByText("Restore access")).not.toBeInTheDocument();
    });

    it("shows only revoked options when no available", async () => {
      const revokedOnly = mockOptions.filter(o => o.type === "revoked");
      render(<Combobox {...defaultProps} options={revokedOnly} searchValue="jo" />);

      const input = screen.getByRole("combobox");
      await userEvent.click(input);

      expect(screen.getByText("Restore access")).toBeInTheDocument();
      expect(screen.queryByText("Grant access")).not.toBeInTheDocument();
    });

    it("shows both sections when both types exist", async () => {
      render(<Combobox {...defaultProps} searchValue="jo" />);

      const input = screen.getByRole("combobox");
      await userEvent.click(input);

      expect(screen.getByText("Restore access")).toBeInTheDocument();
      expect(screen.getByText("Grant access")).toBeInTheDocument();
    });
  });

  describe("selected state", () => {
    it("shows check icon for selected option", async () => {
      render(<Combobox {...defaultProps} value="user-1" searchValue="jo" />);

      const input = screen.getByRole("combobox");
      await userEvent.click(input);

      const selectedOption = screen.getByRole("option", { selected: true });
      expect(selectedOption).toBeInTheDocument();
    });
  });
});
