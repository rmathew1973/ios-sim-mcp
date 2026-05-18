import type { ChildProcess } from "node:child_process";
import type { Snapshot } from "./snapshot.js";
import type { DylibClient } from "./dylib_client.js";

interface State {
  udid: string | null;
  lastSnapshot: Snapshot | null;
  logProc: ChildProcess | null;
  logBuffer: string[];
  logMax: number;
  // Layer 2: per-bundle dylib clients. Populated on first dylib_* call.
  dylibClients: Map<string, DylibClient>;
  // Tracks the most recently launched bundle that was injected, so dylib_*
  // tools can default bundle_id when there's only one in play.
  lastInjectedBundleId: string | null;
}

export const state: State = {
  udid: null,
  lastSnapshot: null,
  logProc: null,
  logBuffer: [],
  logMax: 5000,
  dylibClients: new Map(),
  lastInjectedBundleId: null,
};

export function requireUdid(): string {
  if (!state.udid) {
    throw new Error("No simulator selected. Call use_simulator first, or it will be auto-selected if exactly one is booted.");
  }
  return state.udid;
}
