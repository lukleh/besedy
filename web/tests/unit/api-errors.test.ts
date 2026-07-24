import { describe, it, expect } from "vitest";
import {
  ApiErrorCode,
  isPrismaError,
  apiError,
  notFound,
  conflict,
  badRequest,
  forbidden,
  unauthorized,
  internalError,
} from "@/lib/api/errors";

describe("ApiErrorCode", () => {
  it("has all expected error codes", () => {
    expect(ApiErrorCode.VALIDATION).toBe("VALIDATION_ERROR");
    expect(ApiErrorCode.NOT_FOUND).toBe("NOT_FOUND");
    expect(ApiErrorCode.CONFLICT).toBe("CONFLICT");
    expect(ApiErrorCode.UNAUTHORIZED).toBe("UNAUTHORIZED");
    expect(ApiErrorCode.FORBIDDEN).toBe("FORBIDDEN");
    expect(ApiErrorCode.INTERNAL).toBe("INTERNAL_ERROR");
  });
});

describe("isPrismaError", () => {
  it("returns true for Prisma-like errors", () => {
    expect(isPrismaError({ code: "P2002" })).toBe(true);
    expect(isPrismaError({ code: "P2025", meta: { target: ["id"] } })).toBe(true);
  });

  it("returns false for non-Prisma errors", () => {
    expect(isPrismaError(new Error("test"))).toBe(false);
    expect(isPrismaError({ message: "test" })).toBe(false);
    expect(isPrismaError(null)).toBe(false);
    expect(isPrismaError(undefined)).toBe(false);
    expect(isPrismaError("string error")).toBe(false);
    expect(isPrismaError(123)).toBe(false);
  });

  it("returns false for objects with non-string code", () => {
    expect(isPrismaError({ code: 123 })).toBe(false);
    expect(isPrismaError({ code: null })).toBe(false);
    expect(isPrismaError({ code: undefined })).toBe(false);
  });
});

describe("apiError", () => {
  it("creates error response with message only", async () => {
    const response = apiError("Something went wrong", 500);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Something went wrong");
    expect(body.code).toBeUndefined();
    expect(body.details).toBeUndefined();
  });

  it("creates error response with code", async () => {
    const response = apiError("Not found", 404, ApiErrorCode.NOT_FOUND);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Not found");
    expect(body.code).toBe("NOT_FOUND");
  });

  it("creates error response with details", async () => {
    const details = { field: "email", reason: "invalid format" };
    const response = apiError("Validation failed", 400, ApiErrorCode.VALIDATION, details);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Validation failed");
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details).toEqual(details);
  });

  it("handles various status codes", async () => {
    expect((apiError("", 200)).status).toBe(200);
    expect((apiError("", 201)).status).toBe(201);
    expect((apiError("", 400)).status).toBe(400);
    expect((apiError("", 401)).status).toBe(401);
    expect((apiError("", 403)).status).toBe(403);
    expect((apiError("", 404)).status).toBe(404);
    expect((apiError("", 409)).status).toBe(409);
    expect((apiError("", 500)).status).toBe(500);
  });
});

describe("notFound", () => {
  it("creates 404 response with capitalized resource name", async () => {
    const response = notFound("user");
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("User not found");
    expect(body.code).toBe("NOT_FOUND");
  });

  it("handles multi-word resource names", async () => {
    const response = notFound("catalog entry");
    const body = await response.json();

    expect(body.error).toBe("Catalog entry not found");
  });

  it("handles already capitalized names", async () => {
    const response = notFound("User");
    const body = await response.json();

    expect(body.error).toBe("User not found");
  });
});

describe("conflict", () => {
  it("creates 409 response", async () => {
    const response = conflict("Resource already exists");
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe("Resource already exists");
    expect(body.code).toBe("CONFLICT");
  });

  it("preserves exact message", async () => {
    const message = "A user with email test@example.com already exists";
    const response = conflict(message);
    const body = await response.json();

    expect(body.error).toBe(message);
  });
});

describe("badRequest", () => {
  it("creates 400 response without details", async () => {
    const response = badRequest("Invalid input");
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid input");
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details).toBeUndefined();
  });

  it("creates 400 response with details", async () => {
    const details = [
      { path: ["email"], message: "Invalid email" },
      { path: ["name"], message: "Required" },
    ];
    const response = badRequest("Validation failed", details);
    const body = await response.json();

    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(details);
  });
});

describe("forbidden", () => {
  it("creates 403 response with default message", async () => {
    const response = forbidden();
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe("Access denied");
    expect(body.code).toBe("FORBIDDEN");
  });

  it("creates 403 response with custom message", async () => {
    const response = forbidden("You do not have permission to edit this resource");
    const body = await response.json();

    expect(body.error).toBe("You do not have permission to edit this resource");
  });
});

describe("unauthorized", () => {
  it("creates 401 response with default message", async () => {
    const response = unauthorized();
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe("Authentication required");
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("creates 401 response with custom message", async () => {
    const response = unauthorized("Session expired");
    const body = await response.json();

    expect(body.error).toBe("Session expired");
  });
});

describe("internalError", () => {
  it("creates 500 response with default message", async () => {
    const response = internalError();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Internal server error");
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  it("creates 500 response with custom message", async () => {
    const response = internalError("Database connection failed");
    const body = await response.json();

    expect(body.error).toBe("Database connection failed");
  });
});
