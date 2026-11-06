/**
 * Platform detection for the UI ⇄ Rust boundary.
 *
 * Mobile (Android/iOS) has no user-facing filesystem that the std::fs vault
 * engine can address: scoped storage forbids raw-path access and SAF
 * `content://` URIs can't be consumed by `vault-core`. The mobile UI therefore
 * swaps the folder picker for the app-sandboxed vault manager
 * (`vaults_home` / `vault_list` / `vault_clone`), while desktop keeps the
 * native "open folder" dialog.
 */

const UA = () => (typeof navigator !== "undefined" ? navigator.userAgent : "");

export const isMobile = /Android|iPhone|iPad|iPod/i.test(UA());

export const isAndroid = /Android/i.test(UA());

const LAST_VAULT_KEY = "md.lastVault";

/** Last opened vault dir (mobile only) — lets boot reopen your vault. */
export function readLastVault(): string | null {
  try {
    return localStorage.getItem(LAST_VAULT_KEY);
  } catch {
    return null;
  }
}

export function persistLastVault(dir: string): void {
  if (!isMobile) return;
  try {
    localStorage.setItem(LAST_VAULT_KEY, dir);
  } catch {
    /* private mode — session-only */
  }
}
