import type { ChildProcess } from "node:child_process";
import type { Snapshot } from "./snapshot.js";

interface State {
  udid: string | null;
  lastSnapshot: Snapshot | null;
  logProc: ChildProcess | null;
  logBuffer: string[];
  logMax: number;
}

export const state: State = {
  udid: null,
  lastSnapshot: null,
  logProc: null,
  logBuffer: [],
  logMax: 5000,
};

export function requireUdid(): string {
  if (!state.udid) {
    throw new Error("No simulator selected. Call use_simulator first, or it will be auto-selected if exactly one is booted.");
  }
  return state.udid;
}
