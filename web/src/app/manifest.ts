import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  let relatedAppId: string | undefined;
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? process.env.AUTH_URL;
  if (baseUrl) {
    try {
      relatedAppId = new URL("/manifest.webmanifest", baseUrl).toString();
    } catch {
      relatedAppId = undefined;
    }
  }

  return {
    name: "Besedy - Audio Catalog",
    short_name: "Besedy",
    description:
      "Browse audio catalogs, play recordings, and view synchronized transcripts",
    start_url: "/catalog",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    orientation: "portrait-primary",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "Library",
        url: "/catalog",
        icons: [
          {
            src: "/icon-96.png",
            sizes: "96x96",
            type: "image/png",
          },
        ],
      },
    ],
    related_applications: [
      {
        platform: "webapp",
        url: "/manifest.webmanifest",
        // id is required for desktop detection - must be absolute URL
        ...(relatedAppId ? { id: relatedAppId } : {}),
      },
    ],
    categories: ["entertainment", "music"],
  };
}
