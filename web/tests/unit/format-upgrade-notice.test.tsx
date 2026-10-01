import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormatUpgradeNotice } from "@/components/offline/format-upgrade-notice";

const redownload = vi.fn();
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/lib/offline/download-manager", () => ({
  downloadManager: { redownload: (key: string) => redownload(key) },
}));

describe("FormatUpgradeNotice", () => {
  it("explains the problem and downloads the recording again", () => {
    render(<FormatUpgradeNotice downloadKey="cat:hash" />);

    expect(screen.getByTestId("format-upgrade-notice")).toHaveTextContent("formatUpgrade");
    fireEvent.click(screen.getByRole("button", { name: /redownload/ }));
    expect(redownload).toHaveBeenCalledWith("cat:hash");
  });
});
