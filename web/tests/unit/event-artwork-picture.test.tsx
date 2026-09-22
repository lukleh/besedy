import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EventArtworkPicture } from "@/components/catalog/event-artwork-picture";

const mocks = vi.hoisted(() => ({ isOnline: true }));

vi.mock("@/hooks/use-online-status", () => ({
  useOnlineStatus: () => ({ isOnline: mocks.isOnline }),
}));

describe("EventArtworkPicture", () => {
  it("requests the server variants first and switches to the local copy when that request fails", () => {
    mocks.isOnline = true;
    render(
      <EventArtworkPicture
        catalogId="cat"
        eventId={7}
        artworkId="art-1"
        alt="Evening talk"
        fallbackSrc="blob:local-artwork"
      />
    );
    const image = screen.getByAltText("Evening talk");
    expect(image).toHaveAttribute("src", expect.stringContaining("/api/"));
    expect(screen.queryByTestId("event-artwork-local")).not.toBeInTheDocument();

    fireEvent.error(image);

    expect(screen.getByTestId("event-artwork-local")).toHaveAttribute("src", "blob:local-artwork");
  });

  it("keeps the server image when there is no local copy to fall back to", () => {
    mocks.isOnline = true;
    render(<EventArtworkPicture catalogId="cat" eventId={7} artworkId="art-1" alt="Evening talk" />);
    const image = screen.getByAltText("Evening talk");
    fireEvent.error(image);
    expect(screen.getByAltText("Evening talk")).toHaveAttribute("src", expect.stringContaining("/api/"));
  });

  it("uses the local copy directly when the browser reports no connection", () => {
    mocks.isOnline = false;
    render(
      <EventArtworkPicture
        catalogId="cat"
        eventId={7}
        artworkId="art-1"
        alt="Evening talk"
        fallbackSrc="blob:local-artwork"
      />
    );
    expect(screen.getByTestId("event-artwork-local")).toBeInTheDocument();
  });
});
