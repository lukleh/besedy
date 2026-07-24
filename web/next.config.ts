import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin();
const catalogSyncStartupStub = `${process.cwd()}/src/lib/catalog-sync-startup.stub.ts`;

// Parse extra dev origin hostnames from environment variable (comma-separated).
// Example: DEV_EXTRA_ORIGINS=192.168.1.x,100.x.y.z
const extraDevOrigins = process.env.DEV_EXTRA_ORIGINS
  ? process.env.DEV_EXTRA_ORIGINS.split(",").map((o) => o.trim())
  : [];

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Keep Prisma packages external to avoid bundler resolving internal runtime files.
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "@iarna/toml"],
  // Enable experimental features
  experimental: {
    // Enable View Transitions API for smooth page transitions
    viewTransition: true,
    // Next.js 16 renamed middleware.* config to proxy.*.
    // Allow larger request bodies for file uploads (sources, posters, etc.)
    proxyClientMaxBodySize: "100mb",
  },
  // Keep Turbopack scoped to the web app (avoid repo-root lockfile ambiguity)
  turbopack: {
    root: process.cwd(),
  },
  // Enable standalone output for Docker production builds
  output: "standalone",
  // Allow dev requests from network IPs (LAN / Tailscale) — set via DEV_EXTRA_ORIGINS.
  allowedDevOrigins: [...extraDevOrigins],
  // Rewrites for mock OAuth proxy (dev/test only).
  // Browser requests hit /mock-oauth/* and Next proxies to the internal service.
  async rewrites() {
    const mockOAuthUrl = process.env.OAUTH_MOCK_URL;
    if (!mockOAuthUrl) {
      return { beforeFiles: [], afterFiles: [], fallback: [] };
    }
    return {
      beforeFiles: [
        {
          source: "/mock-oauth/:path*",
          destination: `${mockOAuthUrl}/:path*`,
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
  webpack(config, { webpack }) {
    if (process.env.NODE_ENV === "development") {
      config.resolve = config.resolve ?? {};
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        "@/lib/catalog-sync-startup$": catalogSyncStartupStub,
        "@/lib/catalog-sync-startup.ts$": catalogSyncStartupStub,
        "pg-native": false,
      };
      config.resolve.fallback = {
        ...(config.resolve.fallback ?? {}),
        crypto: false,
        dns: false,
        fs: false,
        "fs/promises": false,
        module: false,
        net: false,
        os: false,
        path: false,
        process: false,
        stream: false,
        string_decoder: false,
        tls: false,
        url: false,
      };
      config.plugins = config.plugins ?? [];
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /^node:/,
          (resource: { request: string }) => {
            resource.request = resource.request.replace(/^node:/, "");
          }
        )
      );
    }
    return config;
  },
  // Image optimization configuration
  images: {
    // Enable image optimization
    unoptimized: false,
    // Image formats to generate
    formats: ["image/avif", "image/webp"],
    // Device sizes for responsive images
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048],
    // Icon sizes for smaller images
    imageSizes: [16, 32, 48, 64, 96, 128, 256],
    // Remote patterns for external images (e.g., user avatars from OAuth)
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.googleusercontent.com",
      },
      {
        protocol: "https",
        hostname: "avatars.githubusercontent.com",
      },
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
    ],
  },
  // Compression
  compress: true,
  // Powered by header (disable for security)
  poweredByHeader: false,
  // Strict mode for React
  reactStrictMode: true,
};

export default withNextIntl(nextConfig);
