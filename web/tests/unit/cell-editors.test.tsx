import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TextCellEditor } from "@/components/catalog/inline-edit/text-cell-editor";
import { NumberCellEditor } from "@/components/catalog/inline-edit/number-cell-editor";
import { CheckboxCellEditor } from "@/components/catalog/inline-edit/checkbox-cell-editor";
import { DateCellEditor } from "@/components/catalog/inline-edit/date-cell-editor";
import { SelectCellEditor } from "@/components/catalog/inline-edit/select-cell-editor";
import { NextIntlClientProvider } from "next-intl";

// Mock messages for next-intl
const messages = {
  catalog: {
    inlineEdit: {
      year: "Year",
      month: "Month",
      day: "Day",
    },
  },
};

// Wrapper for components that use next-intl
function IntlWrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

describe("TextCellEditor", () => {
  it("renders with initial value", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <TextCellEditor value="Initial" onChange={onChange} onCommit={onCommit} />
    );

    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("Initial");
  });

  it("focuses input on mount", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <TextCellEditor value="" onChange={onChange} onCommit={onCommit} />
    );

    const input = screen.getByRole("textbox");
    expect(document.activeElement).toBe(input);
  });

  it("calls onChange with new value when typing", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <TextCellEditor value="" onChange={onChange} onCommit={onCommit} />
    );

    const input = screen.getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "New Value");

    // onChange called for each character
    expect(onChange).toHaveBeenCalled();
    // Last call should have the full value
    expect(onChange).toHaveBeenLastCalledWith("New Value");
  });

  it("normalizes empty string to null", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <TextCellEditor value="Initial" onChange={onChange} onCommit={onCommit} />
    );

    const input = screen.getByRole("textbox");
    await userEvent.clear(input);

    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("normalizes whitespace-only to null", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <TextCellEditor value="" onChange={onChange} onCommit={onCommit} />
    );

    const input = screen.getByRole("textbox");
    await userEvent.type(input, "   ");

    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("calls onCommit when Enter is pressed", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <TextCellEditor value="Test" onChange={onChange} onCommit={onCommit} />
    );

    const input = screen.getByRole("textbox");
    await userEvent.type(input, "{Enter}");

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("reverts to original value on Escape", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <TextCellEditor value="Original" onChange={onChange} onCommit={onCommit} />
    );

    const input = screen.getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "Changed");
    onChange.mockClear();

    await userEvent.type(input, "{Escape}");

    // Should reset to original value
    expect(onChange).toHaveBeenCalledWith("Original");
    expect(onCommit).toHaveBeenCalled();
  });

  it("respects maxLength prop", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <TextCellEditor value="" onChange={onChange} onCommit={onCommit} maxLength={10} />
    );

    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("maxLength", "10");
  });
});

describe("NumberCellEditor", () => {
  it("renders with initial value", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <NumberCellEditor value={5} onChange={onChange} onCommit={onCommit} />
    );

    const input = screen.getByRole("spinbutton");
    expect(input).toHaveValue(5);
  });

  it("focuses input on mount", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <NumberCellEditor value={1} onChange={onChange} onCommit={onCommit} />
    );

    const input = screen.getByRole("spinbutton");
    expect(document.activeElement).toBe(input);
  });

  it("calls onChange with parsed number", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <NumberCellEditor value={1} onChange={onChange} onCommit={onCommit} />
    );

    const input = screen.getByRole("spinbutton");
    await userEvent.clear(input);
    await userEvent.type(input, "10");

    expect(onChange).toHaveBeenCalledWith(10);
  });

  it("returns null for empty input", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <NumberCellEditor value={5} onChange={onChange} onCommit={onCommit} />
    );

    const input = screen.getByRole("spinbutton");
    await userEvent.clear(input);

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("clamps value to min", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <NumberCellEditor value={5} onChange={onChange} onCommit={onCommit} min={1} />
    );

    const input = screen.getByRole("spinbutton");
    await userEvent.clear(input);
    await userEvent.type(input, "0");

    // Should be clamped to min
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it("clamps value to max", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <NumberCellEditor value={5} onChange={onChange} onCommit={onCommit} max={10} />
    );

    const input = screen.getByRole("spinbutton");
    await userEvent.clear(input);
    await userEvent.type(input, "15");

    // Should be clamped to max
    expect(onChange).toHaveBeenCalledWith(10);
  });

  it("calls onCommit on Enter", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <NumberCellEditor value={5} onChange={onChange} onCommit={onCommit} />
    );

    const input = screen.getByRole("spinbutton");
    await userEvent.type(input, "{Enter}");

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("reverts on Escape", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <NumberCellEditor value={5} onChange={onChange} onCommit={onCommit} />
    );

    const input = screen.getByRole("spinbutton");
    await userEvent.clear(input);
    await userEvent.type(input, "99");
    onChange.mockClear();

    await userEvent.type(input, "{Escape}");

    expect(onChange).toHaveBeenCalledWith(5);
    expect(onCommit).toHaveBeenCalled();
  });
});

describe("CheckboxCellEditor", () => {
  it("renders with checked state", () => {
    const onChange = vi.fn();
    render(<CheckboxCellEditor value={true} onChange={onChange} />);

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeChecked();
  });

  it("renders with unchecked state", () => {
    const onChange = vi.fn();
    render(<CheckboxCellEditor value={false} onChange={onChange} />);

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();
  });

  it("treats undefined as false", () => {
    const onChange = vi.fn();
    render(<CheckboxCellEditor value={undefined} onChange={onChange} />);

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();
  });

  it("calls onChange when toggled", async () => {
    const onChange = vi.fn();
    render(<CheckboxCellEditor value={false} onChange={onChange} />);

    const checkbox = screen.getByRole("checkbox");
    await userEvent.click(checkbox);

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("displays label when provided", () => {
    const onChange = vi.fn();
    render(<CheckboxCellEditor value={false} onChange={onChange} label="Verified" />);

    expect(screen.getByText("Verified")).toBeInTheDocument();
  });
});

describe("DateCellEditor", () => {
  it("renders with initial values", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <IntlWrapper>
        <DateCellEditor
          value={{ year: 2024, month: 6, day: 15 }}
          onChange={onChange}
          onCommit={onCommit}
        />
      </IntlWrapper>
    );

    const inputs = screen.getAllByRole("spinbutton");
    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toHaveValue(2024); // year
    expect(inputs[1]).toHaveValue(6); // month
    expect(inputs[2]).toHaveValue(15); // day
  });

  it("focuses year input on mount", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <IntlWrapper>
        <DateCellEditor
          value={{ year: null, month: null, day: null }}
          onChange={onChange}
          onCommit={onCommit}
        />
      </IntlWrapper>
    );

    const inputs = screen.getAllByRole("spinbutton");
    expect(document.activeElement).toBe(inputs[0]);
  });

  it("calls onChange when year is changed", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <IntlWrapper>
        <DateCellEditor
          value={{ year: 2024, month: null, day: null }}
          onChange={onChange}
          onCommit={onCommit}
        />
      </IntlWrapper>
    );

    const inputs = screen.getAllByRole("spinbutton");
    await userEvent.clear(inputs[0]);
    await userEvent.type(inputs[0], "2025");

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ year: 2025 })
    );
  });

  it("clamps month to 1-12", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <IntlWrapper>
        <DateCellEditor
          value={{ year: 2024, month: null, day: null }}
          onChange={onChange}
          onCommit={onCommit}
        />
      </IntlWrapper>
    );

    const inputs = screen.getAllByRole("spinbutton");
    await userEvent.clear(inputs[1]);
    await userEvent.type(inputs[1], "15");

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ month: 12 })
    );
  });

  it("clamps month minimum to 1", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <IntlWrapper>
        <DateCellEditor
          value={{ year: 2024, month: null, day: null }}
          onChange={onChange}
          onCommit={onCommit}
        />
      </IntlWrapper>
    );

    const inputs = screen.getAllByRole("spinbutton");
    await userEvent.clear(inputs[1]);
    await userEvent.type(inputs[1], "0");

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ month: 1 })
    );
  });

  it("clamps day to 1-31", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <IntlWrapper>
        <DateCellEditor
          value={{ year: 2024, month: 1, day: null }}
          onChange={onChange}
          onCommit={onCommit}
        />
      </IntlWrapper>
    );

    const inputs = screen.getAllByRole("spinbutton");
    await userEvent.clear(inputs[2]);
    await userEvent.type(inputs[2], "40");

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ day: 31 })
    );
  });

  it("allows partial dates (year only)", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <IntlWrapper>
        <DateCellEditor
          value={{ year: 2024, month: null, day: null }}
          onChange={onChange}
          onCommit={onCommit}
        />
      </IntlWrapper>
    );

    // Just check the year input exists and has value
    const inputs = screen.getAllByRole("spinbutton");
    expect(inputs[0]).toHaveValue(2024);
    expect(inputs[1]).toHaveValue(null);
    expect(inputs[2]).toHaveValue(null);
  });

  it("calls onCommit on Enter in any field", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <IntlWrapper>
        <DateCellEditor
          value={{ year: 2024, month: 6, day: 15 }}
          onChange={onChange}
          onCommit={onCommit}
        />
      </IntlWrapper>
    );

    const inputs = screen.getAllByRole("spinbutton");
    await userEvent.type(inputs[1], "{Enter}");

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("reverts on Escape", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const originalValue = { year: 2024, month: 6, day: 15 };
    render(
      <IntlWrapper>
        <DateCellEditor
          value={originalValue}
          onChange={onChange}
          onCommit={onCommit}
        />
      </IntlWrapper>
    );

    const inputs = screen.getAllByRole("spinbutton");
    await userEvent.clear(inputs[0]);
    await userEvent.type(inputs[0], "2025");
    onChange.mockClear();

    await userEvent.type(inputs[0], "{Escape}");

    expect(onChange).toHaveBeenCalledWith(originalValue);
    expect(onCommit).toHaveBeenCalled();
  });
});

// Note: SelectCellEditor tests are skipped due to Radix Select requiring
// browser APIs (scrollIntoView) not available in jsdom/happy-dom.
// The component is tested via E2E tests in inline-edit.spec.ts instead.
describe("SelectCellEditor", () => {
  const options = [
    { id: 1, name: "Option 1" },
    { id: 2, name: "Option 2" },
    { id: 3, name: "Option 3" },
  ];

  it("renders combobox trigger", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <SelectCellEditor
        value={2}
        onChange={onChange}
        onCommit={onCommit}
        options={options}
      />
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toBeInTheDocument();
  });

  it("shows loading placeholder when isLoading is true", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <SelectCellEditor
        value={null}
        onChange={onChange}
        onCommit={onCommit}
        options={[]}
        isLoading={true}
      />
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Loading...");
  });

  it("shows custom placeholder when provided", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <SelectCellEditor
        value={null}
        onChange={onChange}
        onCommit={onCommit}
        options={options}
        placeholder="Choose an option"
      />
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Choose an option");
  });
});
