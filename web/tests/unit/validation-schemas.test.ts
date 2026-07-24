import { describe, it, expect } from "vitest";
import {
  TimestampIdSchema,
  CuidSchema,
  HashSchema,
  EmailSchema,
  AccessLevelSchema,
  AccessStatusSchema,
  UserStatusSchema,
  TranscriptBackendSchema,
  AudioSourceSchema,
  PaginationSchema,
  GrantAccessSchema,
  UpdateAccessSchema,
  UpdateAccessWithNameSchema,
  RestoreAccessSchema,
  UserSearchQuerySchema,
  UpdateUserSchema,
  CreatePendingCatalogGrantSchema,
  UpdateRecordingMetadataSchema,
  AudioQuerySchema,
} from "@/lib/validation/schemas";

describe("TimestampIdSchema", () => {
  it("accepts valid timestamp IDs", () => {
    expect(TimestampIdSchema.safeParse("20251201_143022").success).toBe(true);
    expect(TimestampIdSchema.safeParse("20240101_000000").success).toBe(true);
    expect(TimestampIdSchema.safeParse("20991231_235959").success).toBe(true);
  });

  it("rejects CUID format", () => {
    expect(TimestampIdSchema.safeParse("cm2abc123def456ghi789jkl").success).toBe(false);
    expect(TimestampIdSchema.safeParse("cuid_test_123").success).toBe(false);
  });

  it("rejects invalid formats", () => {
    expect(TimestampIdSchema.safeParse("invalid").success).toBe(false);
    expect(TimestampIdSchema.safeParse("2025-12-01").success).toBe(false);
    expect(TimestampIdSchema.safeParse("20251201").success).toBe(false);
    expect(TimestampIdSchema.safeParse("143022").success).toBe(false);
    expect(TimestampIdSchema.safeParse("").success).toBe(false);
  });

  it("rejects timestamps with wrong digit counts", () => {
    expect(TimestampIdSchema.safeParse("2025121_143022").success).toBe(false); // 7 date digits
    expect(TimestampIdSchema.safeParse("20251201_14302").success).toBe(false); // 5 time digits
  });
});

describe("CuidSchema", () => {
  it("accepts valid CUIDs", () => {
    // CUIDs are 25+ chars total (c + 24+ alphanumeric)
    expect(CuidSchema.safeParse("cm2abc123def456ghi789jklmn").success).toBe(true); // 26 chars
    expect(CuidSchema.safeParse("c12345678901234567890123456").success).toBe(true); // 27 chars
    expect(CuidSchema.safeParse("clyrxz1qw000008l9d6zk9q2x").success).toBe(true); // realistic CUID
  });

  it("rejects non-CUID formats", () => {
    expect(CuidSchema.safeParse("20251201_143022").success).toBe(false);
    expect(CuidSchema.safeParse("invalid").success).toBe(false);
    expect(CuidSchema.safeParse("").success).toBe(false);
  });

  it("rejects CUIDs that don't start with 'c'", () => {
    expect(CuidSchema.safeParse("a12345678901234567890123456").success).toBe(false);
  });

  it("rejects CUIDs that are too short", () => {
    expect(CuidSchema.safeParse("c1234567890123456789012").success).toBe(false); // 23 chars after 'c', need 24+
  });
});

describe("HashSchema", () => {
  it("accepts valid SHA-256 hashes", () => {
    expect(HashSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(HashSchema.safeParse("0123456789abcdef".repeat(4)).success).toBe(true);
  });

  it("rejects invalid hashes", () => {
    expect(HashSchema.safeParse("a".repeat(63)).success).toBe(false); // too short
    expect(HashSchema.safeParse("a".repeat(65)).success).toBe(false); // too long
    expect(HashSchema.safeParse("g".repeat(64)).success).toBe(false); // invalid hex char
  });
});

describe("EmailSchema", () => {
  it("accepts valid emails", () => {
    expect(EmailSchema.safeParse("test@example.com").success).toBe(true);
    expect(EmailSchema.safeParse("user.name@domain.org").success).toBe(true);
  });

  it("normalizes emails to lowercase", () => {
    const result = EmailSchema.safeParse("TEST@EXAMPLE.COM");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("test@example.com");
    }
  });

  it("trims whitespace from emails", () => {
    const result = EmailSchema.safeParse("  user@example.com  ");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("user@example.com");
    }
  });

  it("canonicalizes Gmail addresses (removes dots)", () => {
    const result = EmailSchema.safeParse("john.doe@gmail.com");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("johndoe@gmail.com");
    }
  });

  it("canonicalizes Gmail addresses (removes +suffix)", () => {
    const result = EmailSchema.safeParse("user+work@gmail.com");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("user@gmail.com");
    }
  });

  it("normalizes googlemail.com to gmail.com", () => {
    const result = EmailSchema.safeParse("user@googlemail.com");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("user@gmail.com");
    }
  });

  it("preserves dots for non-Gmail addresses", () => {
    const result = EmailSchema.safeParse("john.doe@example.com");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("john.doe@example.com");
    }
  });

  it("rejects invalid emails", () => {
    expect(EmailSchema.safeParse("invalid").success).toBe(false);
    expect(EmailSchema.safeParse("@example.com").success).toBe(false);
    expect(EmailSchema.safeParse("test@").success).toBe(false);
  });
});

describe("AccessLevelSchema", () => {
  it("accepts valid access levels", () => {
    expect(AccessLevelSchema.safeParse("VIEWER").success).toBe(true);
    expect(AccessLevelSchema.safeParse("MEMBER").success).toBe(true);
    expect(AccessLevelSchema.safeParse("EDITOR").success).toBe(true);
    expect(AccessLevelSchema.safeParse("OWNER").success).toBe(true);
  });

  it("rejects invalid access levels", () => {
    expect(AccessLevelSchema.safeParse("viewer").success).toBe(false); // lowercase
    expect(AccessLevelSchema.safeParse("ADMIN").success).toBe(false);
    expect(AccessLevelSchema.safeParse("invalid").success).toBe(false);
  });
});

describe("AccessStatusSchema", () => {
  it("accepts valid access statuses", () => {
    expect(AccessStatusSchema.safeParse("ACTIVE").success).toBe(true);
    expect(AccessStatusSchema.safeParse("REVOKED").success).toBe(true);
  });

  it("rejects invalid access statuses", () => {
    expect(AccessStatusSchema.safeParse("active").success).toBe(false);
    expect(AccessStatusSchema.safeParse("PENDING").success).toBe(false);
    expect(AccessStatusSchema.safeParse("").success).toBe(false);
  });
});

describe("UserStatusSchema", () => {
  it("accepts valid user statuses", () => {
    expect(UserStatusSchema.safeParse("ACTIVE").success).toBe(true);
    expect(UserStatusSchema.safeParse("PENDING").success).toBe(true);
    expect(UserStatusSchema.safeParse("BLOCKED").success).toBe(true);
  });

  it("rejects invalid statuses", () => {
    expect(UserStatusSchema.safeParse("").success).toBe(false);
    expect(UserStatusSchema.safeParse("SUSPENDED").success).toBe(false);
    expect(UserStatusSchema.safeParse("active").success).toBe(false);
  });
});

describe("TranscriptBackendSchema", () => {
  it("accepts valid backends", () => {
    expect(
      TranscriptBackendSchema.safeParse("faster-whisper/large-v3@silero_vad_v6").success
    ).toBe(true);
    expect(
      TranscriptBackendSchema.safeParse("canary-nemo/nvidia_canary-1b-v2").success
    ).toBe(true);
    expect(
      TranscriptBackendSchema.safeParse("whisperx/large-v3@silero").success
    ).toBe(true);
  });

  it("rejects invalid backends", () => {
    expect(TranscriptBackendSchema.safeParse("").success).toBe(false);
    expect(TranscriptBackendSchema.safeParse("faster-whisper").success).toBe(false);
    expect(TranscriptBackendSchema.safeParse("faster-whisper/..").success).toBe(false);
    expect(TranscriptBackendSchema.safeParse("faster-whisper/large/v3").success).toBe(false);
    expect(TranscriptBackendSchema.safeParse("openai-whisper").success).toBe(false);
  });
});

describe("AudioSourceSchema", () => {
  it("accepts valid audio sources", () => {
    expect(AudioSourceSchema.safeParse("archived").success).toBe(true);
    expect(AudioSourceSchema.safeParse("listening").success).toBe(true);
    expect(AudioSourceSchema.safeParse("original").success).toBe(true);
  });

  it("rejects invalid sources", () => {
    expect(AudioSourceSchema.safeParse("").success).toBe(false);
    expect(AudioSourceSchema.safeParse("raw").success).toBe(false);
  });
});

describe("PaginationSchema", () => {
  it("parses valid pagination params", () => {
    const result = PaginationSchema.safeParse({ page: "2", limit: "50" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(2);
      expect(result.data.limit).toBe(50);
    }
  });

  it("uses defaults when not provided", () => {
    const result = PaginationSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
    }
  });

  it("rejects invalid values", () => {
    expect(PaginationSchema.safeParse({ page: "0" }).success).toBe(false); // Min 1
    expect(PaginationSchema.safeParse({ limit: "101" }).success).toBe(false); // Max 100
  });
});

describe("GrantAccessSchema", () => {
  it("accepts valid access grant", () => {
    const result = GrantAccessSchema.safeParse({
      userId: "c" + "a".repeat(24),
      accessLevel: "EDITOR",
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional notes", () => {
    const result = GrantAccessSchema.safeParse({
      userId: "c" + "a".repeat(24),
      accessLevel: "VIEWER",
      notes: "Granted for project X",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    expect(GrantAccessSchema.safeParse({}).success).toBe(false);
    expect(GrantAccessSchema.safeParse({ userId: "c" + "a".repeat(24) }).success).toBe(false);
    expect(GrantAccessSchema.safeParse({ accessLevel: "VIEWER" }).success).toBe(false);
  });

  it("rejects notes exceeding max length", () => {
    const result = GrantAccessSchema.safeParse({
      userId: "c" + "a".repeat(24),
      accessLevel: "VIEWER",
      notes: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });
});

describe("UpdateAccessSchema", () => {
  it("accepts valid updates", () => {
    const result = UpdateAccessSchema.safeParse({
      accessLevel: "MEMBER",
      notes: "Updated notes",
    });
    expect(result.success).toBe(true);
  });

  it("requires accessLevel", () => {
    expect(UpdateAccessSchema.safeParse({}).success).toBe(false);
    expect(UpdateAccessSchema.safeParse({ notes: "Missing level" }).success).toBe(false);
  });

  it("rejects notes that are too long", () => {
    const result = UpdateAccessSchema.safeParse({
      accessLevel: "VIEWER",
      notes: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });
});

describe("UpdateAccessWithNameSchema", () => {
  it("accepts access update with user name", () => {
    const result = UpdateAccessWithNameSchema.safeParse({
      accessLevel: "EDITOR",
      userName: "Updated Name",
      notes: "Notes",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty user name", () => {
    const result = UpdateAccessWithNameSchema.safeParse({
      accessLevel: "VIEWER",
      userName: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects user name over max length", () => {
    const result = UpdateAccessWithNameSchema.safeParse({
      accessLevel: "VIEWER",
      userName: "x".repeat(101),
    });
    expect(result.success).toBe(false);
  });
});

describe("RestoreAccessSchema", () => {
  it("accepts restore action", () => {
    const result = RestoreAccessSchema.safeParse({ action: "restore" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid restore action", () => {
    const result = RestoreAccessSchema.safeParse({ action: "invalid" });
    expect(result.success).toBe(false);
  });
});

describe("UserSearchQuerySchema", () => {
  it("accepts optional search param", () => {
    expect(UserSearchQuerySchema.safeParse({}).success).toBe(true);
    expect(UserSearchQuerySchema.safeParse({ search: "alice" }).success).toBe(true);
  });

  it("rejects search terms that are too long", () => {
    const result = UserSearchQuerySchema.safeParse({ search: "x".repeat(101) });
    expect(result.success).toBe(false);
  });
});

describe("UpdateUserSchema", () => {
  it("accepts valid user updates", () => {
    expect(UpdateUserSchema.safeParse({ status: "ACTIVE" }).success).toBe(true);
    expect(UpdateUserSchema.safeParse({ isAdmin: true }).success).toBe(true);
    expect(UpdateUserSchema.safeParse({ status: "BLOCKED", isAdmin: false }).success).toBe(true);
  });

  it("accepts empty object (no updates)", () => {
    expect(UpdateUserSchema.safeParse({}).success).toBe(true);
  });

  it("rejects pending status (allowlist-only semantics)", () => {
    expect(UpdateUserSchema.safeParse({ status: "PENDING" }).success).toBe(false);
  });
});

describe("CreatePendingCatalogGrantSchema", () => {
  it("accepts valid pending catalog grant payload", () => {
    const result = CreatePendingCatalogGrantSchema.safeParse({
      email: "user@example.com",
      accessLevel: "MEMBER",
    });
    expect(result.success).toBe(true);
  });

  it("lowercases email", () => {
    const result = CreatePendingCatalogGrantSchema.safeParse({
      email: "USER@EXAMPLE.COM",
      accessLevel: "VIEWER",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("user@example.com");
    }
  });

  it("accepts optional message", () => {
    const result = CreatePendingCatalogGrantSchema.safeParse({
      email: "user@example.com",
      accessLevel: "EDITOR",
      message: "Welcome to the catalog!",
    });
    expect(result.success).toBe(true);
  });
});

describe("UpdateRecordingMetadataSchema", () => {
  it("accepts valid metadata updates", () => {
    const result = UpdateRecordingMetadataSchema.safeParse({
      title: "My Recording",
      description: "A description",
      tags: ["interview", "czech"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts nullable fields", () => {
    const result = UpdateRecordingMetadataSchema.safeParse({
      title: null,
      recorderId: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts numeric IDs", () => {
    const result = UpdateRecordingMetadataSchema.safeParse({
      recorderId: 1,
      locationId: 42,
    });
    expect(result.success).toBe(true);
  });

  it("rejects too many tags", () => {
    const result = UpdateRecordingMetadataSchema.safeParse({
      tags: Array(21).fill("tag"),
    });
    expect(result.success).toBe(false);
  });

  it("rejects too long title", () => {
    const result = UpdateRecordingMetadataSchema.safeParse({
      title: "x".repeat(201),
    });
    expect(result.success).toBe(false);
  });
});

describe("AudioQuerySchema", () => {
  it("accepts valid audio query params", () => {
    const result = AudioQuerySchema.safeParse({
      source: "archived",
      group: "20251201_143022",
    });
    expect(result.success).toBe(true);
  });

  it("uses default source when not provided", () => {
    const result = AudioQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe("archived");
    }
  });

  it("transforms download string to boolean", () => {
    const resultTrue = AudioQuerySchema.safeParse({ download: "true" });
    expect(resultTrue.success).toBe(true);
    if (resultTrue.success) {
      expect(resultTrue.data.download).toBe(true);
    }

    const resultFalse = AudioQuerySchema.safeParse({ download: "false" });
    expect(resultFalse.success).toBe(true);
    if (resultFalse.success) {
      expect(resultFalse.data.download).toBe(false);
    }
  });
});
