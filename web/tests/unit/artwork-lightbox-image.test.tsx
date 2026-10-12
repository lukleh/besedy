import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import messages from "../../messages/en.json";
import { ArtworkLightboxImage } from "@/components/catalog/artwork-lightbox-image";

function renderAndOpen() {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ArtworkLightboxImage src="/api/square.png" title="Blue version – Square" />
    </NextIntlClientProvider>
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  const trigger = screen.getByRole("button", { name: "Enlarge image: Blue version – Square" });
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: "Blue version – Square" }) };
}

async function expectClosed(trigger: HTMLElement) {
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
}

describe("ArtworkLightboxImage", () => {
  it("shows the image fitted to the screen and closes when the image is clicked", async () => {
    const { trigger, dialog } = renderAndOpen();
    const enlarged = dialog.querySelector("img");
    expect(enlarged).toHaveAttribute("src", "/api/square.png");
    expect(enlarged).toHaveClass("h-full", "w-full", "object-contain");
    expect(dialog).toHaveClass("fixed", "inset-0");

    fireEvent.click(enlarged!);
    await expectClosed(trigger);
  });

  it("closes when the area around the image is clicked", async () => {
    const { trigger, dialog } = renderAndOpen();
    fireEvent.click(dialog);
    await expectClosed(trigger);
  });

  it("closes on Escape", async () => {
    const { trigger, dialog } = renderAndOpen();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await expectClosed(trigger);
  });

  it("offers a close button to assistive technology", async () => {
    const { trigger } = renderAndOpen();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await expectClosed(trigger);
  });

  it("enlarges the full-size image while the thumbnail keeps the web image", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ArtworkLightboxImage src="/api/square.web" fullSrc="/api/square.original" title="Blue version – Square" />
      </NextIntlClientProvider>
    );
    const trigger = screen.getByRole("button", { name: "Enlarge image: Blue version – Square" });
    expect(trigger.querySelector("img")).toHaveAttribute("src", "/api/square.web");

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Blue version – Square" });
    expect(dialog.querySelector("img")).toHaveAttribute("src", "/api/square.original");
  });
});
