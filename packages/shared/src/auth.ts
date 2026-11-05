/**
 * Sign-up / sign-in messages. Username + password only.
 */
import { z } from "zod";

/** Case-insensitive: "Deepan" and "deepan" are the same account. */
export const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "username must be at least 3 characters")
  .max(32, "username must be at most 32 characters")
  .regex(/^[a-z0-9._-]+$/, "username may contain only letters, digits, . _ -");

/** Never trimmed or transformed: what you type is what is hashed. */
export const PasswordSchema = z
  .string()
  .min(8, "password must be at least 8 characters")
  .max(256, "password must be at most 256 characters");

export const CredentialsSchema = z.strictObject({
  username: UsernameSchema,
  password: PasswordSchema,
});
export type Credentials = z.infer<typeof CredentialsSchema>;

export const UserSchema = z.strictObject({
  id: z.string(),
  username: z.string(),
});
export type User = z.infer<typeof UserSchema>;

/** `token` goes in every later request: `Authorization: Bearer <token>`. */
export const AuthResponseSchema = z.strictObject({
  token: z.string(),
  user: UserSchema,
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const ErrorCodeSchema = z.enum([
  "invalid_request",
  "unauthorized",
  "invalid_credentials",
  "username_taken",
  "signup_disabled",
  "rate_limited",
  "not_found",
  "payload_too_large",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorResponseSchema = z.strictObject({
  error: ErrorCodeSchema,
  message: z.string(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
