import { vi } from "vitest";

/**
 * One canonical mock for the Tauri boundary, applied to every test file via
 * `setupFiles` (vitest.config.ts). Suites configure specific command replies
 * with `vi.mocked(invoke)`; a suite needing entirely different behavior can
 * still override with its own local `vi.mock`.
 *
 * Keep this export list a superset of what `src/` imports from each module —
 * an import missing here is silently `undefined` in every suite.
 */
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class Channel {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));
