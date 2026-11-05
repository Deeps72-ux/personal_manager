import type { ErrorCode } from "@pm/shared";

/** The server could not be reached (offline, Mac asleep, Tailscale off...). */
export class NetworkError extends Error {
  constructor(message = "Server unreachable") {
    super(message);
    this.name = "NetworkError";
  }
}

/** The session token is missing, expired or revoked: sign in again. */
export class AuthExpiredError extends Error {
  constructor() {
    super("Session expired, please sign in again");
    this.name = "AuthExpiredError";
  }
}

/** The server answered with an error response. */
export class RemoteError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string, status: number) {
    super(message);
    this.name = "RemoteError";
    this.code = code;
    this.status = status;
  }
}

/** Input the user typed is not acceptable. Message is shown in the UI. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
