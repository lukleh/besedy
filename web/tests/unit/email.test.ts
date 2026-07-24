import { describe, it, expect } from "vitest";
import { canonicalizeEmail, emailsMatch } from "@/lib/email";

describe("canonicalizeEmail", () => {
  describe("basic normalization", () => {
    it("lowercases the entire email", () => {
      expect(canonicalizeEmail("TEST@EXAMPLE.COM")).toBe("test@example.com");
      expect(canonicalizeEmail("User@Domain.Org")).toBe("user@domain.org");
    });

    it("trims leading and trailing whitespace", () => {
      expect(canonicalizeEmail("  test@example.com  ")).toBe("test@example.com");
      expect(canonicalizeEmail("\tuser@domain.org\n")).toBe("user@domain.org");
    });

    it("handles both trim and lowercase together", () => {
      expect(canonicalizeEmail("  TEST@EXAMPLE.COM  ")).toBe("test@example.com");
    });
  });

  describe("Gmail-specific normalization", () => {
    it("removes dots from Gmail local part", () => {
      expect(canonicalizeEmail("john.doe@gmail.com")).toBe("johndoe@gmail.com");
      expect(canonicalizeEmail("j.o.h.n@gmail.com")).toBe("john@gmail.com");
    });

    it("removes +suffix from Gmail addresses", () => {
      expect(canonicalizeEmail("user+work@gmail.com")).toBe("user@gmail.com");
      expect(canonicalizeEmail("user+newsletter+extra@gmail.com")).toBe("user@gmail.com");
    });

    it("handles dots and +suffix together for Gmail", () => {
      expect(canonicalizeEmail("john.doe+work@gmail.com")).toBe("johndoe@gmail.com");
    });

    it("normalizes googlemail.com to gmail.com", () => {
      expect(canonicalizeEmail("user@googlemail.com")).toBe("user@gmail.com");
      expect(canonicalizeEmail("john.doe+tag@googlemail.com")).toBe("johndoe@gmail.com");
    });

    it("applies case normalization to Gmail addresses", () => {
      expect(canonicalizeEmail("John.Doe+Work@GMAIL.COM")).toBe("johndoe@gmail.com");
    });
  });

  describe("non-Gmail addresses", () => {
    it("does NOT remove dots from non-Gmail addresses", () => {
      expect(canonicalizeEmail("john.doe@example.com")).toBe("john.doe@example.com");
      expect(canonicalizeEmail("user.name@company.org")).toBe("user.name@company.org");
    });

    it("does NOT remove +suffix from non-Gmail addresses", () => {
      expect(canonicalizeEmail("user+tag@example.com")).toBe("user+tag@example.com");
    });

    it("preserves dots and +suffix for non-Gmail", () => {
      expect(canonicalizeEmail("john.doe+work@company.com")).toBe("john.doe+work@company.com");
    });
  });

  describe("edge cases", () => {
    it("handles emails with no @ sign gracefully", () => {
      // Invalid email - just returns normalized string
      expect(canonicalizeEmail("invalid")).toBe("invalid");
    });

    it("handles emails with multiple @ signs", () => {
      // Uses lastIndexOf for @, so this becomes local="weird@local" domain="example.com"
      expect(canonicalizeEmail("weird@local@example.com")).toBe("weird@local@example.com");
    });

    it("handles empty local part", () => {
      expect(canonicalizeEmail("@gmail.com")).toBe("@gmail.com");
    });

    it("handles empty string", () => {
      expect(canonicalizeEmail("")).toBe("");
    });

    it("handles only whitespace", () => {
      expect(canonicalizeEmail("   ")).toBe("");
    });
  });
});

describe("emailsMatch", () => {
  it("returns true for identical emails", () => {
    expect(emailsMatch("test@example.com", "test@example.com")).toBe(true);
  });

  it("returns true for case-different emails", () => {
    expect(emailsMatch("test@example.com", "TEST@EXAMPLE.COM")).toBe(true);
  });

  it("returns true for Gmail dot variations", () => {
    expect(emailsMatch("john.doe@gmail.com", "johndoe@gmail.com")).toBe(true);
    expect(emailsMatch("j.o.h.n@gmail.com", "john@gmail.com")).toBe(true);
  });

  it("returns true for Gmail +suffix variations", () => {
    expect(emailsMatch("user@gmail.com", "user+work@gmail.com")).toBe(true);
    expect(emailsMatch("user+a@gmail.com", "user+b@gmail.com")).toBe(true);
  });

  it("returns true for Gmail and googlemail.com", () => {
    expect(emailsMatch("user@gmail.com", "user@googlemail.com")).toBe(true);
  });

  it("returns false for different non-Gmail addresses", () => {
    expect(emailsMatch("user@example.com", "other@example.com")).toBe(false);
  });

  it("returns false for non-Gmail dot variations (dots matter)", () => {
    expect(emailsMatch("john.doe@example.com", "johndoe@example.com")).toBe(false);
  });

  it("returns false for non-Gmail +suffix (suffix matters)", () => {
    expect(emailsMatch("user@example.com", "user+tag@example.com")).toBe(false);
  });
});
