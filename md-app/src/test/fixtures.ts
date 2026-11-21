import type { VaultFile } from "@/lib/vault";

/**
 * Domain-data factories for browser tests. Factories (not shared literals)
 * so a suite mutating its fixture can't leak state into the next one, and a
 * new required field on the type gets one default here instead of a fix in
 * every suite.
 */
export function vaultFile(overrides: Partial<VaultFile> = {}): VaultFile {
  return { path: "notes/Note.md", content: "", committed: null, ...overrides };
}
