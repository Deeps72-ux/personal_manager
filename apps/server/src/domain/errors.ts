/**
 * Business-level failures. They carry a stable `code` but NO HTTP status:
 * mapping codes to status codes is the HTTP adapter's job (SRP), so the core
 * stays usable from a CLI, a test, or a different transport.
 */
import type { ErrorCode } from "@pm/shared";

export class DomainError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InvalidRequestError extends DomainError {
  constructor(message: string) {
    super("invalid_request", message);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = "Not signed in or session expired") {
    super("unauthorized", message);
  }
}

export class InvalidCredentialsError extends DomainError {
  constructor() {
    super("invalid_credentials", "Wrong username or password");
  }
}

export class UsernameTakenError extends DomainError {
  constructor() {
    super("username_taken", "That username is already taken");
  }
}

export class SignUpDisabledError extends DomainError {
  constructor() {
    super("signup_disabled", "Sign-up is disabled on this server");
  }
}
