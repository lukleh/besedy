import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UnauthorizedPage from "@/app/(app)/auth/unauthorized/page";

const searchParamsMock = vi.fn(() => new URLSearchParams());

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParamsMock(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    key === "unauthorized.attemptedEmail" ? `Attempted email: ${values?.email}` : key,
}));

describe("UnauthorizedPage", () => {
  beforeEach(() => {
    searchParamsMock.mockReturnValue(new URLSearchParams());
  });

  it.each<Record<string, string>>([
    { error: "not_authorized:user@example.com" },
    { error: "access_denied", error_description: "not_authorized:user@example.com" },
  ])("displays the email from an admission denial %j", (params) => {
    searchParamsMock.mockReturnValue(new URLSearchParams(params));

    render(<UnauthorizedPage />);

    expect(screen.getByText("Attempted email: user@example.com")).toBeInTheDocument();
  });

  it.each(["state_mismatch", "provider_specific_error: diagnostic"])(
    "does not interpret OAuth error %s as an email",
    (error) => {
      searchParamsMock.mockReturnValue(new URLSearchParams({ error }));

      render(<UnauthorizedPage />);

      expect(screen.queryByText(/Attempted email:/)).not.toBeInTheDocument();
    }
  );
});
