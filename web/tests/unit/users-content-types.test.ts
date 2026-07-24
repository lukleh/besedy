import { describe, expect, it } from "vitest";
import { AccessLevel, UserStatus } from "@/generated/prisma/enums";
import {
  getPendingPortalAdmissionMutationPath,
  getUserInitials,
  isPendingPortalAdmission,
  summarizeCatalogNames,
  type PendingPortalAdmission,
  type User,
} from "@/app/admin/users/users-content-types";

const baseUser: User = {
  id: "user-1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  image: null,
  status: UserStatus.ACTIVE,
  isSuperadmin: false,
  isAdmin: false,
  lastLoginAt: null,
  createdAt: "2026-03-10T00:00:00.000Z",
  activatedAt: null,
  highestAccessLevel: null,
  catalogNames: [],
};

const basePendingAdmission: PendingPortalAdmission = {
  id: "inv-1",
  type: "portal_admission",
  email: "invitee@example.com",
  invitedAt: "2026-03-10T00:00:00.000Z",
  pendingGrants: [
    {
      catalogId: "catalog-1",
      catalogLabel: "Catalog One",
      accessLevel: AccessLevel.VIEWER,
      grantedAt: "2026-03-10T00:00:00.000Z",
      grantedBy: {
        id: "admin-1",
        name: "Admin User",
        email: "admin@example.com",
      },
      notes: null,
    },
  ],
  catalogNames: ["Catalog One"],
  pendingGrantCount: 1,
  catalogId: "catalog-1",
  catalogLabel: "Catalog One",
  accessLevel: AccessLevel.VIEWER,
  invitedBy: {
    id: "admin-1",
    name: "Admin User",
    email: "admin@example.com",
  },
  notes: null,
};

describe("users content helper types", () => {
  it("derives initials from the user name when available", () => {
    expect(getUserInitials("Ada Lovelace", "ada@example.com")).toBe("AL");
  });

  it("falls back to the email prefix when the user has no name", () => {
    expect(getUserInitials(null, "user@example.com")).toBe("US");
  });

  it("returns null for an empty catalog summary", () => {
    expect(summarizeCatalogNames([])).toBeNull();
  });

  it("keeps short catalog summaries readable", () => {
    expect(summarizeCatalogNames(["One"])).toBe("One");
    expect(summarizeCatalogNames(["One", "Two"])).toBe("One, Two");
  });

  it("compresses long catalog summaries after the first two labels", () => {
    expect(summarizeCatalogNames(["One", "Two", "Three"])).toBe("One, Two +1");
  });

  it("detects pending portal admissions by their discriminant", () => {
    expect(isPendingPortalAdmission(basePendingAdmission)).toBe(true);
    expect(isPendingPortalAdmission(baseUser)).toBe(false);
  });

  it("uses the portal admission route for pending admission mutations", () => {
    expect(
      getPendingPortalAdmissionMutationPath({
        ...basePendingAdmission,
        id: "pending@example.com",
      })
    ).toBe("/api/admin/portal-admissions/pending@example.com");
  });
});
