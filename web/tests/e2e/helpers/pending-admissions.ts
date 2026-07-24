/**
 * Pending admission helpers for E2E tests
 */

import { APIRequestContext } from "@playwright/test";

export interface PendingAdmissionData {
  email: string;
  catalogId?: string;
  accessLevel?: string;
}

export interface PendingAdmissionResponse {
  id: string;
  email: string;
  status: string;
  catalogAccess?: { catalogId: string; accessLevel: string } | null;
}

export interface PendingAdmissionDetails {
  id: string;
  email: string;
  status: "PENDING" | "CONSUMED";
  invitedAt: string;
  catalogId: string | null;
  accessLevel: string | null;
  consumedAt: string | null;
  consumedById: string | null;
}

/**
 * Create a pending admission via the admin API.
 * Requires authentication as admin.
 *
 * @param request - Playwright API request context (with auth cookies)
 * @param data - Pending admission data
 */
export async function createPendingAdmission(
  request: APIRequestContext,
  data: PendingAdmissionData
): Promise<PendingAdmissionResponse> {
  const response = await request.post("/api/admin/portal-admissions", {
    data,
  });

  if (!response.ok()) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(`Failed to create pending admission: ${error.error || response.status()}`);
  }

  return response.json();
}

/**
 * Get pending admission details by canonical email.
 *
 * @param request - Playwright API request context (with auth cookies)
 * @param admissionId - Canonical email
 */
export async function getPendingAdmission(
  request: APIRequestContext,
  admissionId: string
): Promise<PendingAdmissionDetails> {
  if (!admissionId.includes("@")) {
    throw new Error("Pending portal admissions must be fetched by canonical email");
  }

  const path = `/api/admin/portal-admissions/${encodeURIComponent(admissionId)}`;
  const response = await request.get(path);

  if (!response.ok()) {
    throw new Error(`Failed to get pending admission: ${response.status()}`);
  }

  return response.json();
}

/**
 * Delete (revoke) a pending admission.
 *
 * @param request - Playwright API request context (with auth cookies)
 * @param admissionId - Canonical email
 */
export async function deletePendingAdmission(
  request: APIRequestContext,
  admissionId: string
): Promise<void> {
  if (!admissionId.includes("@")) {
    throw new Error("Pending portal admissions must be deleted by canonical email");
  }

  const path = `/api/admin/portal-admissions/${encodeURIComponent(admissionId)}`;
  const response = await request.delete(path);

  if (!response.ok()) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(`Failed to delete pending admission: ${error.error || response.status()}`);
  }
}

/**
 * List pending admissions only.
 */
export async function listPendingAdmissions(
  request: APIRequestContext
): Promise<PendingAdmissionDetails[]> {
  const response = await request.get("/api/admin/portal-admissions");

  if (!response.ok()) {
    throw new Error(`Failed to list pending admissions: ${response.status()}`);
  }

  return response.json();
}
