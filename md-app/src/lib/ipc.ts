/**
 * Typed helpers for the UI ⇄ Rust command boundary (see docs/api.md).
 *
 * Commands reject with a structured payload `{ code, message }` (FND-13).
 * Plain-string rejections (older plugin paths, ad-hoc errors) are still
 * accepted so every call site can use one error pipeline.
 */

export type AppErrorCode = "auth" | "vault" | "path-escape" | "invalid-input" | "io" | "internal";

export type AppErrorPayload = { code: AppErrorCode; message: string };

export function isAppError(e: unknown): e is AppErrorPayload {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    "message" in e &&
    typeof (e as { code: unknown }).code === "string" &&
    typeof (e as { message: unknown }).message === "string"
  );
}

/** Human-readable text from any rejection shape (AppError, string, Error). */
export function errorMessage(e: unknown): string {
  if (isAppError(e)) return e.message;
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Auth failures: prefer the typed `auth` code, fall back to the loose regex
 * for transports that surface plain text (git2 push vs gix fetch).
 */
export function isAuthError(e: unknown): boolean {
  if (isAppError(e)) return e.code === "auth";
  return /auth|credential/i.test(errorMessage(e));
}
