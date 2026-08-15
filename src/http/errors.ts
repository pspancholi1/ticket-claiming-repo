/** Machine-readable error codes returned to clients. */
export const ErrorCode = {
  validationFailed: "VALIDATION_FAILED",
  agentIdRequired: "AGENT_ID_REQUIRED",
  ticketNotFound: "TICKET_NOT_FOUND",
  ticketAlreadyClaimed: "TICKET_ALREADY_CLAIMED",
  claimNotHeld: "CLAIM_NOT_HELD",
  internal: "INTERNAL_ERROR",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** An error whose HTTP representation is deliberate rather than incidental. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCodeValue,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (message: string) =>
  new AppError(404, ErrorCode.ticketNotFound, message);

/** The ticket exists, but it belongs to someone else right now. */
export const alreadyClaimed = (message: string) =>
  new AppError(409, ErrorCode.ticketAlreadyClaimed, message);

/** The caller's claim has lapsed, or was never theirs. */
export const claimNotHeld = (message: string) =>
  new AppError(409, ErrorCode.claimNotHeld, message);
