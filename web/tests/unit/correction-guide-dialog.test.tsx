import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CorrectionGuideDialog } from "@/components/correction/correction-guide-dialog";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

describe("CorrectionGuideDialog", () => {
  it("opens the guide over the page, formatted", async () => {
    render(<CorrectionGuideDialog body={"# Návod pro korektury\n\n- **Čísla** pište číslicemi.\n- Cizí slova v původním pravopisu."} />);
    expect(screen.queryByTestId("correction-guide")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("correction-guide-open"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { level: 1, name: "Návod pro korektury" })).toBeInTheDocument();
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
    expect(within(dialog).getByText("Čísla").tagName).toBe("STRONG");
    expect(dialog).not.toHaveTextContent("**");

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
