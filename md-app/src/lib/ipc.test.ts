import { describe, expect, it } from "vitest";
import { errorMessage, isAppError, isAuthError } from "./ipc";

describe("isAppError", () => {
  it("accepts structured { code, message } payloads", () => {
    expect(isAppError({ code: "auth", message: "authentication required" })).toBe(true);
    expect(isAppError({ code: "vault", message: "boom" })).toBe(true);
  });

  it("rejects non-error shapes", () => {
    expect(isAppError("authentication required")).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError({ code: 1, message: "x" })).toBe(false);
    expect(isAppError({ code: "auth" })).toBe(false);
  });
});

describe("errorMessage", () => {
  it("extracts the message from structured payloads", () => {
    expect(errorMessage({ code: "io", message: "disk on fire" })).toBe("disk on fire");
  });

  it("passes plain strings through", () => {
    expect(errorMessage("legacy string error")).toBe("legacy string error");
  });

  it("unwraps Error instances", () => {
    expect(errorMessage(new Error("native"))).toBe("native");
  });

  it("stringifies anything else", () => {
    expect(errorMessage(42)).toBe("42");
  });
});

describe("isAuthError", () => {
  it("is true for the typed auth code", () => {
    expect(isAuthError({ code: "auth", message: "authentication required" })).toBe(true);
  });

  it("is false for other structured codes even with auth-ish text", () => {
    expect(isAuthError({ code: "vault", message: "authentication required" })).toBe(false);
  });

  it("falls back to regex matching for plain strings (transport variance)", () => {
    expect(isAuthError("remote: credentials not provided")).toBe(true);
    expect(isAuthError("authentication required")).toBe(true);
    expect(isAuthError("vault corrupted")).toBe(false);
  });
});
