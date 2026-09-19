import { describe, expect, it } from "vitest";
import { redactDatabaseUrl, resolveHostDatabaseUrl } from "@/lib/script-env";

describe("resolveHostDatabaseUrl", () => {
  const containerUrl = "postgresql://user:secret@db:5432/besedy?schema=public";

  it("uses the published host and port for a host-run operator command", () => {
    expect(resolveHostDatabaseUrl(containerUrl, "127.0.0.1:55432")).toBe(
      "postgresql://user:secret@127.0.0.1:55432/besedy?schema=public"
    );
  });

  it("uses loopback when the binding contains only a port", () => {
    expect(resolveHostDatabaseUrl(containerUrl, "55432")).toBe(
      "postgresql://user:secret@127.0.0.1:55432/besedy?schema=public"
    );
  });

  it("leaves the URL unchanged when no published binding is configured", () => {
    expect(resolveHostDatabaseUrl(containerUrl, undefined)).toBe(containerUrl);
  });

  it("rejects malformed bindings", () => {
    expect(() => resolveHostDatabaseUrl(containerUrl, "localhost:not-a-port")).toThrow(
      "DB_PORT must be a port or host:port binding"
    );
  });
});

describe("redactDatabaseUrl", () => {
  it("redacts a standard username/password URL", () => {
    expect(redactDatabaseUrl("postgresql://user:secret@localhost:5432/db")).toBe(
      "postgresql://user:****@localhost:5432/db"
    );
  });

  it("redacts the full password when it contains colons", () => {
    expect(redactDatabaseUrl("postgresql://user:abc:def@localhost:5432/db")).toBe(
      "postgresql://user:****@localhost:5432/db"
    );
  });

  it("redacts credentials with reserved characters", () => {
    expect(
      redactDatabaseUrl(
        "postgresql://user:ab:c%2Fd%40e@localhost:5432/db?sslmode=require#fragment"
      )
    ).toBe("postgresql://user:****@localhost:5432/db?sslmode=require#fragment");
  });

  it("returns the original URL when no password is present", () => {
    expect(redactDatabaseUrl("postgresql://user@localhost:5432/db")).toBe(
      "postgresql://user@localhost:5432/db"
    );
  });

  it("returns the original string for non-URL input", () => {
    expect(redactDatabaseUrl("not-a-url")).toBe("not-a-url");
  });
});
