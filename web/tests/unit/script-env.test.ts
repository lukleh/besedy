import { describe, expect, it } from "vitest";
import { redactDatabaseUrl } from "@/lib/script-env";

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
