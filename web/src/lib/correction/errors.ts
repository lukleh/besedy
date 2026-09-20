export type CorrectionErrorCode =
  | "NOT_ELIGIBLE"
  | "NO_WORKSPACE"
  | "WORKSPACE_EXISTS"
  | "WORKSPACE_ARCHIVED"
  | "WORKSPACE_LOCKED"
  | "SOURCE_MISSING"
  | "SPAN_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "EMPTY_TEXT"
  | "UNCHANGED_TEXT"
  | "NOT_ELIGIBLE_FOR_PUBLICATION"
  | "PUBLICATION_NOT_FOUND"
  | "PUBLICATION_IN_FLIGHT"
  | "PUBLICATION_ACTIVE"
  | "NOT_PUBLISHED"
  | "GUIDE_MISSING";

const STATUS_BY_CODE: Record<CorrectionErrorCode, number> = {
  NOT_ELIGIBLE: 404,
  NO_WORKSPACE: 404,
  WORKSPACE_EXISTS: 409,
  WORKSPACE_ARCHIVED: 409,
  WORKSPACE_LOCKED: 409,
  SOURCE_MISSING: 422,
  SPAN_NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  EMPTY_TEXT: 422,
  UNCHANGED_TEXT: 409,
  NOT_ELIGIBLE_FOR_PUBLICATION: 409,
  PUBLICATION_NOT_FOUND: 404,
  PUBLICATION_IN_FLIGHT: 409,
  PUBLICATION_ACTIVE: 409,
  NOT_PUBLISHED: 409,
  GUIDE_MISSING: 404,
};

export class CorrectionError extends Error {
  readonly code: CorrectionErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: CorrectionErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CorrectionError";
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = details;
  }
}
