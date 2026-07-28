import { getStoredCredentials, migrateLegacyState, resolveAgentDir } from "./dust-state.js";
import type { DustCredentials } from "./dust-types.js";

export { resolveAgentDir };

/**
 * Credentials available at extension-load time, before any session event.
 *
 * Runs the one-time carry-over from the pre-0.81 layout, where Dust state lived
 * inside the auth.json credential blob, then returns the merged view.
 */
export function loadBootstrapDustCredentials(): DustCredentials | null {
  migrateLegacyState();
  return getStoredCredentials();
}
