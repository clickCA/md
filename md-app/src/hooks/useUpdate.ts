import { useCallback, useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { errorMessage } from "../lib/ipc";

const hasTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Drives the updater plugin: one out-of-band check on startup, then a small
 * banner ("Install & restart") while an update is available. `check()` no-ops
 * cleanly outside a Tauri runtime (dev browser, vitest) and any transport
 * failure just means "nothing to install right now" — updates are a nicety,
 * never a hard failure.
 *
 * Relaunch comes from the process plugin because @tauri-apps/api has no
 * process module; both plugins need their `:default` capability entries.
 */
export function useUpdate() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkNow = useCallback(() => {
    if (!hasTauri()) return Promise.resolve();
    // Non-fatal for the UI: unavailable in dev, endpoint unreachable, or a
    // deb/rpm install with no updater bundle — all just mean no banner.
    // setState only in promise callbacks keeps the mount effect clean of
    // set-state-in-effect (same shape as useAgent's agent_detect probe).
    return check()
      .then(setUpdate)
      .catch(() => setUpdate(null));
  }, []);

  // One check at startup on desktop builds.
  useEffect(() => {
    void checkNow();
  }, [checkNow]);

  const install = useCallback(async () => {
    if (!update) return;
    setInstalling(true);
    setError(null);
    try {
      await update.downloadAndInstall();
      // Windows quits the app during install; elsewhere this restarts into
      // the freshly-updated build.
      await relaunch();
    } catch (e) {
      setError(errorMessage(e));
      setInstalling(false);
    }
  }, [update]);

  const dismiss = useCallback(() => setUpdate(null), []);

  return { update, installing, error, checkNow, install, dismiss };
}
